import {AccountMode,KycVerificationStatus,NotificationType,Prisma,UserStatus} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {enqueueKycEmail} from '@/lib/kyc-email-outbox';
import {kycDocumentRegistry} from '@/lib/kyc-verification';
import {createNotification} from '@/lib/notifications';
import {synchronizeCompletedProfileTier} from '@/lib/tier-progression';
import {promoteApprovedKycCaseToTierThree} from '@/lib/kyc-tier-promotion';

const reviewSchema=z.discriminatedUnion('decision',[
	z.object({decision:z.literal('ASSIGN_TO_ME'),confirmed:z.literal(true)}),
	z.object({decision:z.literal('APPROVE'),confirmed:z.literal(true),reason:z.string().trim().max(1000).optional(),internalNote:z.string().trim().max(2000).optional()}),
	z.object({decision:z.literal('REJECT'),confirmed:z.literal(true),reason:z.string().trim().min(3).max(1000),internalNote:z.string().trim().max(2000).optional()}),
	z.object({decision:z.literal('RESUBMISSION_REQUIRED'),confirmed:z.literal(true),reason:z.string().trim().min(3).max(1000),documentIds:z.array(z.string().min(1)).min(1).max(3),internalNote:z.string().trim().max(2000).optional()}),
	z.object({decision:z.literal('ESCALATE'),confirmed:z.literal(true),internalNote:z.string().trim().min(3).max(2000)}),
]);

export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}){
	try{
		const {id}=await params;
		const admin=await requireAdmin();
		const verification=await db.kycVerification.findUnique({
			where:{id},
			select:{
				id:true,status:true,documentCountry:true,documentType:true,registryVersion:true,consentVersion:true,consentAt:true,
				submittedAt:true,processedAt:true,reviewedAt:true,reviewedById:true,assignedToId:true,legalHoldAt:true,legalHoldReason:true,evidencePurgeAttempts:true,evidencePurgeNextAttemptAt:true,evidencePurgeErrorCode:true,decisionReason:true,internalNote:true,assessment:true,createdAt:true,
				user:{select:{id:true,email:true,name:true,firstName:true,lastName:true,country:true,accountMode:true,approvedTier:true,status:true,kycStatus:true,createdAt:true,kyc:{select:{legalName:true,dob:true,address:true,addressLine1:true,addressLine2:true,city:true,stateProvince:true,postalCode:true,addressCountry:true}},kycVerifications:{where:{id:{not:id}},orderBy:{createdAt:'desc'},take:5,select:{id:true,status:true,submittedAt:true,reviewedAt:true,decisionReason:true}}}},
				documents:{select:{id:true,kind:true,documentSide:true,filename:true,mimeType:true,size:true,status:true,uploadedAt:true,reviewedAt:true,reviewNote:true}},
				events:{select:{actorId:true,fromStatus:true,toStatus:true,action:true,reason:true,metadata:true,createdAt:true},orderBy:{createdAt:'asc'}},
				reviewedBy:{select:{id:true,name:true,email:true}},
				assignedTo:{select:{id:true,name:true,email:true}},
			},
		});
		if(!verification)return NextResponse.json({error:'Verification case not found.'},{status:404});
		await db.auditLog.create({data:{
			actorId:admin.id,
			action:'KYC_CASE_ACCESSED',
			entity:'KYC_VERIFICATION',
			entityId:verification.id,
			metadata:{userId:verification.user.id},
		}});
		const latest=await db.kycVerification.findFirst({where:{userId:verification.user.id,status:{not:'CANCELLED'}},orderBy:{createdAt:'desc'},select:{id:true}});
		const documentType=verification.documentType as keyof typeof kycDocumentRegistry;
		return NextResponse.json({
			...verification,
			isLatest:latest?.id===verification.id,
			documentRequirements:kycDocumentRegistry[documentType]?.sides||[],
		},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		console.error('Administrator KYC case could not be loaded.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to load the KYC case.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}

export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){
	try{
		const {id}=await params;
		const admin=await requireAdmin();
		const input=reviewSchema.parse(await request.json());
		const result=await db.$transaction(async tx=>{
			const current=await tx.kycVerification.findUnique({
				where:{id},
				select:{id:true,userId:true,status:true,documentType:true,assignedToId:true,createdAt:true,updatedAt:true},
			});
			if(!current)throw new Error('VERIFICATION_NOT_FOUND');
			if(current.status!==KycVerificationStatus.PENDING_REVIEW&&current.status!==KycVerificationStatus.NEEDS_REVIEW)throw new Error('VERIFICATION_NOT_REVIEWABLE');
			const latest=await tx.kycVerification.findFirst({
				where:{userId:current.userId,status:{not:'CANCELLED'}},
				orderBy:{createdAt:'desc'},
				select:{id:true},
			});
			if(latest?.id!==current.id)throw new Error('NEWER_VERIFICATION_EXISTS');

			const now=new Date();
			if(input.decision==='ASSIGN_TO_ME'){
				if(current.assignedToId===admin.id)return {id:current.id,status:current.status,assignedToId:admin.id,tier3Upgraded:false};
				const assigned=await tx.kycVerification.updateMany({
					where:{id:current.id,status:current.status,updatedAt:current.updatedAt},
					data:{assignedToId:admin.id},
				});
				if(assigned.count!==1)throw new Error('VERIFICATION_CHANGED');
				await tx.kycVerificationEvent.create({data:{
					verificationId:current.id,actorId:admin.id,fromStatus:current.status,toStatus:current.status,
					action:'ASSIGNED_TO_REVIEWER',metadata:{assignedToId:admin.id},
				}});
				await tx.auditLog.create({data:{
					actorId:admin.id,action:'KYC_VERIFICATION_ASSIGNED',entity:'KYC_VERIFICATION',entityId:current.id,
					metadata:{userId:current.userId,assignedToId:admin.id},
				}});
				return {id:current.id,status:current.status,assignedToId:admin.id,tier3Upgraded:false};
			}
			const documents=await tx.kycDocument.findMany({
				where:{verificationId:current.id},
				select:{id:true,kind:true,documentSide:true,status:true},
			});
			if(input.decision==='APPROVE'){
				const documentType=current.documentType as keyof typeof kycDocumentRegistry;
				const requiredSides=kycDocumentRegistry[documentType]?.sides;
				if(!requiredSides||!documents.some(document=>document.kind==='SELFIE')||requiredSides.some(side=>!documents.some(document=>document.kind==='IDENTITY_DOCUMENT'&&document.documentSide===side)))throw new Error('REQUIRED_EVIDENCE_MISSING');
				if(documents.some(document=>['REJECTED','RESUBMISSION_REQUIRED'].includes(document.status)))throw new Error('DOCUMENT_REPLACEMENT_REQUIRED');
			}
			if(input.decision==='RESUBMISSION_REQUIRED'){
				const documentIds=new Set(documents.map(document=>document.id));
				if(input.documentIds.some(documentId=>!documentIds.has(documentId)))throw new Error('INVALID_RESUBMISSION_DOCUMENTS');
			}

			const nextStatus=input.decision==='APPROVE'
				?KycVerificationStatus.APPROVED
				:input.decision==='REJECT'
					?KycVerificationStatus.REJECTED
					:input.decision==='RESUBMISSION_REQUIRED'
						?KycVerificationStatus.RESUBMISSION_REQUIRED
						:KycVerificationStatus.NEEDS_REVIEW;
			const changed=await tx.kycVerification.updateMany({
				where:{id:current.id,status:current.status,updatedAt:current.updatedAt},
				data:{
					status:nextStatus,
					reviewedById:admin.id,
					assignedToId:current.assignedToId||admin.id,
					reviewedAt:input.decision==='ESCALATE'?null:now,
					decisionReason:input.decision==='ESCALATE'?null:input.decision==='APPROVE'?input.reason||null:input.reason,
					internalNote:'internalNote' in input?input.internalNote||null:null,
				},
			});
			if(changed.count!==1)throw new Error('VERIFICATION_CHANGED');

			if(input.decision==='APPROVE'){
				await tx.kycDocument.updateMany({where:{verificationId:current.id,status:{in:['SUBMITTED','UNDER_REVIEW']}},data:{status:'APPROVED',reviewedAt:now,reviewNote:null}});
				const user=await tx.user.findUniqueOrThrow({where:{id:current.userId},select:{id:true,name:true,country:true,phone:true,status:true,role:true,accountMode:true,kycStatus:true,approvedTier:true}});
				if(user.status!==UserStatus.ACTIVE||user.role!=='USER'||user.accountMode!==AccountMode.REAL)throw new Error('ACCOUNT_NOT_ELIGIBLE');
				await synchronizeCompletedProfileTier(tx,user.id);
				await tx.user.update({where:{id:user.id},data:{kycStatus:'APPROVED',verifiedAt:now}});
			}else if(input.decision==='REJECT'||input.decision==='RESUBMISSION_REQUIRED'){
				if(input.decision==='REJECT')await tx.kycDocument.updateMany({where:{verificationId:current.id,status:{in:['SUBMITTED','UNDER_REVIEW']}},data:{status:'REJECTED',reviewedAt:now,reviewNote:input.reason}});
				else await tx.kycDocument.updateMany({where:{id:{in:input.documentIds},verificationId:current.id,status:{in:['SUBMITTED','UNDER_REVIEW']}},data:{status:'RESUBMISSION_REQUIRED',reviewedAt:now,reviewNote:input.reason}});
				await tx.user.update({where:{id:current.userId},data:{kycStatus:input.decision==='REJECT'?'REJECTED':'NEEDS_CHANGES',verifiedAt:null}});
			}

			await tx.kycVerificationEvent.create({data:{
				verificationId:current.id,
				actorId:admin.id,
				fromStatus:current.status,
				toStatus:nextStatus,
				action:input.decision,
				reason:input.decision==='ESCALATE'?null:'reason' in input?input.reason||null:null,
				metadata:input.decision==='RESUBMISSION_REQUIRED'?{documentIds:input.documentIds}:input.decision==='ESCALATE'?{internalNote:input.internalNote}:undefined,
			}});
			await tx.auditLog.create({data:{
				actorId:admin.id,
				action:`KYC_VERIFICATION_${input.decision}`,
				entity:'KYC_VERIFICATION',
				entityId:current.id,
				metadata:{userId:current.userId,fromStatus:current.status,toStatus:nextStatus,...(input.decision==='RESUBMISSION_REQUIRED'?{documentIds:input.documentIds}:{}),...(input.decision==='ESCALATE'?{}:{reason:input.reason||null})},
			}});

			let tier3Upgraded=false;
			if(input.decision==='APPROVE'){
				tier3Upgraded=await promoteApprovedKycCaseToTierThree(tx,{userId:current.userId,verificationId:current.id,administratorId:admin.id,now});
				if(!tier3Upgraded){
					const dedupeKey=`kyc-verification:${current.id}:approved`;
					await createNotification(tx,{
						userId:current.userId,
						type:NotificationType.KYC,
						title:'Identity verification approved',
						message:'An authorized administrator approved your identity verification. Tier 3 remains subject to your existing profile and proof-of-address requirements.',
						dedupeKey,
						actionUrl:'/kyc',
					});
					await enqueueKycEmail(tx,current.userId,'VERIFICATION_APPROVED',dedupeKey);
				}
			}else if(input.decision==='REJECT'||input.decision==='RESUBMISSION_REQUIRED'){
				const dedupeKey=`kyc-verification:${current.id}:${nextStatus}`;
				await createNotification(tx,{
					userId:current.userId,
					type:NotificationType.KYC,
					title:input.decision==='REJECT'?'Identity verification decision':'Identity verification update required',
					message:input.reason,
					dedupeKey,
					actionUrl:'/kyc',
				});
				await enqueueKycEmail(tx,current.userId,input.decision==='REJECT'?'VERIFICATION_REJECTED':'VERIFICATION_RESUBMISSION',dedupeKey);
			}
			return {id:current.id,status:nextStatus,reviewedAt:input.decision==='ESCALATE'?null:now,tier3Upgraded};
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		return NextResponse.json(result,{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof ZodError)return NextResponse.json({error:'Confirm the decision and provide valid review details.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Review data must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='VERIFICATION_NOT_FOUND')return NextResponse.json({error:'Verification case not found.'},{status:404});
		if(error instanceof Error&&['VERIFICATION_NOT_REVIEWABLE','NEWER_VERIFICATION_EXISTS','VERIFICATION_CHANGED','REQUIRED_EVIDENCE_MISSING','DOCUMENT_REPLACEMENT_REQUIRED','INVALID_RESUBMISSION_DOCUMENTS','ACCOUNT_NOT_ELIGIBLE'].includes(error.message))return NextResponse.json({error:'This case changed or is not eligible for that decision. Refresh the review workspace.'},{status:409});
		if(error&&typeof error==='object'&&'code' in error&&['P2002','P2034'].includes(String(error.code)))return NextResponse.json({error:'The case changed during review. Refresh the review workspace.'},{status:409});
		console.error('Administrator KYC decision could not be saved.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to save the KYC decision.'},{status:503});
	}
}
