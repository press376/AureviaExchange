import {AccountMode,NotificationType,Prisma} from '@prisma/client';
import {Country} from 'country-state-city';
import {NextResponse} from 'next/server';
import {requireUser} from '@/lib/auth';
import {db} from '@/lib/db';
import {createNotification,notifyActiveAdmins} from '@/lib/notifications';
import {enqueueKycEmail} from '@/lib/kyc-email-outbox';
import {createManualReviewAssessment,kycConsentVersion,kycDocumentRegistry,kycRegistryVersion,KycDocumentType,KycInputError,KycImageSide,maxKycImageBytes,validateKycImage} from '@/lib/kyc-verification';
import {createPrivateObjectKey,deletePrivateObject,PrivateStorageError,uploadPrivateObject} from '@/lib/private-storage';
import {getTierProfileRequirements} from '@/lib/production-policy';
import {rateLimit} from '@/lib/rate-limit';

const maxRequestBytes=3*maxKycImageBytes+64*1024;
const allowedTypes=(Object.keys(kycDocumentRegistry) as KycDocumentType[]).filter(type=>kycDocumentRegistry[type].enabled);

async function readBoundedFormData(request:Request){
	const declaredLength=request.headers.get('content-length');
	if(declaredLength!==null){
		const length=Number(declaredLength);
		if(!Number.isSafeInteger(length)||length<0)throw new KycInputError('The upload request is invalid.');
		if(length>maxRequestBytes)throw new KycInputError('The combined image uploads must be 24 MB or smaller.',413);
	}
	if(!request.body)throw new KycInputError('The upload request is empty.');
	const reader=request.body.getReader();
	const chunks:Uint8Array[]=[];
	let size=0;
	while(true){
		const {done,value}=await reader.read();
		if(done)break;
		size+=value.byteLength;
		if(size>maxRequestBytes){
			await reader.cancel();
			throw new KycInputError('The combined image uploads must be 24 MB or smaller.',413);
		}
		chunks.push(value);
	}
	const headers=new Headers(request.headers);
	headers.delete('content-length');
	try{
		return await new Request(request.url,{method:'POST',headers,body:Buffer.concat(chunks)}).formData();
	}catch{
		throw new KycInputError('The upload request could not be read.');
	}
}

export async function GET(){
	try{
		const user=await requireUser();
		const activeUser=await db.user.findUnique({where:{id:user.id},select:{status:true,accountMode:true}});
		if(!activeUser||activeUser.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(activeUser.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Identity verification is available in REAL mode only.'},{status:403});
		const verifications=await db.kycVerification.findMany({
			where:{userId:user.id},
			orderBy:{createdAt:'desc'},
			take:10,
			select:{
				id:true,status:true,documentCountry:true,documentType:true,registryVersion:true,consentAt:true,
				submittedAt:true,processedAt:true,reviewedAt:true,decisionReason:true,assessment:true,createdAt:true,
				documents:{select:{id:true,kind:true,documentSide:true,filename:true,mimeType:true,size:true,status:true,uploadedAt:true,reviewedAt:true,reviewNote:true}},
				events:{select:{fromStatus:true,toStatus:true,action:true,reason:true,createdAt:true},orderBy:{createdAt:'asc'}},
			},
		});
		return NextResponse.json({registry:allowedTypes.map(type=>({type,label:kycDocumentRegistry[type].label,sides:kycDocumentRegistry[type].sides})),verifications},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		const unauthorized=error instanceof Error&&error.message==='UNAUTHORIZED';
		if(!unauthorized)console.error('KYC verification status could not be loaded.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:unauthorized?'Unauthorized':'Unable to load verification status.'},{status:unauthorized?401:503,headers:{'Cache-Control':'private, no-store'}});
	}
}

export async function POST(request:Request){
	const uploadedObjects:{ownerId:string;key:string}[]=[];
	try{
		const user=await requireUser();
		rateLimit(`kyc-verification-submit:${user.id}`,3,60*60_000);
		const form=await readBoundedFormData(request);
		const seenFields=new Set<string>();
		const allowedFields=new Set(['documentCountry','documentType','consent','documentFront','documentBack','selfie']);
		for(const [field] of form.entries()){
			if(!allowedFields.has(field)||seenFields.has(field))throw new KycInputError('The upload request contains invalid fields.');
			seenFields.add(field);
		}
		const countryCode=String(form.get('documentCountry')||'').trim().toUpperCase();
		const documentType=String(form.get('documentType')||'') as KycDocumentType;
		if(!/^[A-Z]{2}$/.test(countryCode)||!Country.getAllCountries().some(country=>country.isoCode===countryCode))throw new KycInputError('Select a valid document-issuing country.');
		if(!Object.hasOwn(kycDocumentRegistry,documentType)||!kycDocumentRegistry[documentType].enabled)throw new KycInputError('Select a document type currently enabled for Aurevia Verify.');
		if(form.get('consent')!=='true')throw new KycInputError('Consent is required before submitting identity evidence.');
		const requirements=kycDocumentRegistry[documentType];
		const inputFiles:{side:KycImageSide;file:File}[]=[];
		for(const side of requirements.sides){
			const file=form.get(side==='FRONT'?'documentFront':'documentBack');
			if(!(file instanceof File))throw new KycInputError(`A ${side.toLowerCase()} document image is required.`);
			inputFiles.push({side,file});
		}
		if(documentType==='PASSPORT'&&form.get('documentBack') instanceof File)throw new KycInputError('A back image is not required for passports.');
		const selfie=form.get('selfie');
		if(!(selfie instanceof File))throw new KycInputError('A live selfie capture is required.');
		inputFiles.push({side:'SELFIE',file:selfie});
		if(inputFiles.reduce((sum,item)=>sum+item.file.size,0)>3*maxKycImageBytes)throw new KycInputError('The combined image uploads must be 24 MB or smaller.',413);

		const current=await db.user.findUnique({where:{id:user.id},select:{id:true,name:true,country:true,phone:true,status:true,accountMode:true,approvedTier:true,kycStatus:true,kycDocuments:{select:{id:true}},kyc:{select:{submittedAt:true}}}});
		if(!current||current.status!=='ACTIVE')return NextResponse.json({error:'This account is unavailable.'},{status:403});
		if(current.accountMode!==AccountMode.REAL)return NextResponse.json({error:'Identity verification is available in REAL mode only.'},{status:403});
		if(current.approvedTier>=3)return NextResponse.json({error:'Your account has already reached Tier 3.'},{status:409});
		if(!getTierProfileRequirements(current).profileComplete)return NextResponse.json({error:'Complete your name and country in Profile before submitting identity verification.'},{status:409});
		if(current.kycDocuments.length+inputFiles.length>30)return NextResponse.json({error:'The account document limit has been reached.'},{status:409});

		const validated=await Promise.all(inputFiles.map(async item=>({...item,...await validateKycImage(item.file,item.side)})));
		for(const item of validated){
			const key=createPrivateObjectKey('kyc',user.id,item.mime);
			uploadedObjects.push({ownerId:user.id,key});
			await uploadPrivateObject('kyc',user.id,key,item.bytes,item.mime);
		}

		const now=new Date();
		const result=await db.$transaction(async tx=>{
			const latest=await tx.kycVerification.findFirst({where:{userId:user.id},orderBy:{createdAt:'desc'},select:{status:true}});
			if(latest?.status==='APPROVED')throw new Error('VERIFICATION_ALREADY_APPROVED');
			const active=await tx.kycVerification.findFirst({
				where:{userId:user.id,status:{in:['DRAFT','SUBMITTED','PROCESSING','PENDING_REVIEW','NEEDS_REVIEW','RESUBMISSION_REQUIRED']}},
				orderBy:{createdAt:'desc'},
				select:{id:true,status:true},
			});
			if(active&&active.status!=='RESUBMISSION_REQUIRED')throw new Error('VERIFICATION_ALREADY_ACTIVE');
			if(active){
				const changed=await tx.kycVerification.updateMany({where:{id:active.id,status:'RESUBMISSION_REQUIRED'},data:{status:'CANCELLED'}});
				if(changed.count!==1)throw new Error('VERIFICATION_ALREADY_ACTIVE');
				await tx.kycVerificationEvent.create({data:{verificationId:active.id,fromStatus:'RESUBMISSION_REQUIRED',toStatus:'CANCELLED',action:'SUPERSEDED_BY_RESUBMISSION',actorId:user.id}});
			}
			const verification=await tx.kycVerification.create({data:{
				userId:user.id,
				supersedesId:active?.id||null,
				status:'DRAFT',
				documentCountry:countryCode,
				documentType,
				registryVersion:kycRegistryVersion,
				consentVersion:kycConsentVersion,
				consentAt:now,
				assessment:createManualReviewAssessment(),
			}});
			const documents=await Promise.all(validated.map(async(item,index)=>{
				const key=uploadedObjects[index].key;
				const filename=item.file.name.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,255)||`${item.side.toLowerCase()}.${item.mime.split('/')[1]}`;
				return tx.kycDocument.create({data:{
					userId:user.id,
					verificationId:verification.id,
					kind:item.side==='SELFIE'?'SELFIE':'IDENTITY_DOCUMENT',
					documentSide:item.side,
					filename,
					storageKey:key,
					mimeType:item.mime,
					size:item.bytes.length,
					sha256:item.sha256,
					status:'SUBMITTED',
				},select:{id:true,kind:true,documentSide:true}});
			}));
			await tx.kycVerificationEvent.create({data:{verificationId:verification.id,fromStatus:'DRAFT',toStatus:'SUBMITTED',action:'USER_SUBMITTED',actorId:user.id}});
			const submitted=await tx.kycVerification.updateMany({where:{id:verification.id,status:'DRAFT'},data:{status:'SUBMITTED',submittedAt:now}});
			if(submitted.count!==1)throw new Error('VERIFICATION_STATE_CHANGED');
			const processing=await tx.kycVerification.updateMany({where:{id:verification.id,status:'SUBMITTED'},data:{status:'PROCESSING'}});
			if(processing.count!==1)throw new Error('VERIFICATION_STATE_CHANGED');
			await tx.kycVerificationEvent.create({data:{verificationId:verification.id,fromStatus:'SUBMITTED',toStatus:'PROCESSING',action:'BASIC_FILE_VALIDATION'}});
			const reviewed=await tx.kycVerification.updateMany({where:{id:verification.id,status:'PROCESSING'},data:{status:'PENDING_REVIEW',processedAt:now}});
			if(reviewed.count!==1)throw new Error('VERIFICATION_STATE_CHANGED');
			await tx.kycVerificationEvent.create({data:{verificationId:verification.id,fromStatus:'PROCESSING',toStatus:'PENDING_REVIEW',action:'AUTOMATED_ASSESSMENT_UNAVAILABLE'}});
			const dedupeKey=`kyc-verification:${verification.id}:submitted`;
			await createNotification(tx,{userId:user.id,type:NotificationType.KYC,title:'Identity verification submitted',message:'Your identity documents and selfie were received. Automated OCR and liveness analysis are not available, so an administrator will review your submission.',dedupeKey,actionUrl:'/kyc'});
			await notifyActiveAdmins(tx,{type:NotificationType.KYC,title:'Identity verification awaiting review',message:`A first-party identity verification case (${verification.id}) requires manual review. Automated biometric checks are unavailable.`,dedupeKey:`${dedupeKey}:admin`,relatedEntity:'KYC_VERIFICATION',relatedId:verification.id,actionUrl:'/admin/kyc'});
			await enqueueKycEmail(tx,user.id,'VERIFICATION_SUBMITTED',dedupeKey);
			return {id:verification.id,status:'PENDING_REVIEW',documents};
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		return NextResponse.json(result,{status:201,headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		await Promise.all(uploadedObjects.map(object=>deletePrivateObject('kyc',object.ownerId,object.key)));
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof KycInputError)return NextResponse.json({error:error.message},{status:error.status});
		if(error instanceof PrivateStorageError)return NextResponse.json({error:error.message},{status:error.status});
		if(error instanceof Error&&error.message==='RATE_LIMITED')return NextResponse.json({error:'Too many verification submissions. Try again later.'},{status:429});
		if(error instanceof Error&&error.message==='VERIFICATION_ALREADY_ACTIVE')return NextResponse.json({error:'A verification case is already awaiting review.'},{status:409});
		if(error instanceof Error&&error.message==='VERIFICATION_ALREADY_APPROVED')return NextResponse.json({error:'Your first-party identity verification is already approved.'},{status:409});
		if(error instanceof Error&&error.message==='VERIFICATION_STATE_CHANGED')return NextResponse.json({error:'The verification case changed while submitting. Try again.'},{status:409});
		const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
		if(code==='P2002'||code==='P2034')return NextResponse.json({error:'The verification case changed while submitting. Refresh its status and try again.'},{status:409});
		console.error('KYC verification submission failed.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to submit identity verification.'},{status:503});
	}
}
