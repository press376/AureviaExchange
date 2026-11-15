import {NextResponse} from 'next/server';
import {getServerSession} from 'next-auth';
import {z,ZodError} from 'zod';
import {authFailureStatus,requireAdmin,requireUser} from '@/lib/auth';
import {authOptions} from '@/lib/auth-options';
import {db} from '@/lib/db';
import {isSameOriginRequest} from '@/lib/push-notifications';
import {getCurrentLegalDocuments,getLegalAcceptanceStatus,recordLegalAcceptances,type CurrentLegalDocument} from '@/lib/legal-acceptance';
import {CURRENT_TERMS_VERSION} from '@/lib/policy-consent';

const acceptanceSchema=z.union([
	z.object({version:z.string().min(1).max(128),accepted:z.literal(true)}).strict(),
	z.object({
		documents:z.array(z.object({documentKey:z.string().min(1).max(64),version:z.string().min(1).max(128)}).strict()).min(1).max(20),
		accepted:z.literal(true),
	}).strict(),
]);
const privateHeaders={'Cache-Control':'private, no-store'};

async function requireTermsAccount(){
	const session=await getServerSession(authOptions);
	return session?.user?.role==='ADMIN'
		?requireAdmin({skipTermsAcceptance:true})
		:requireUser({skipTermsAcceptance:true});
}

export async function GET(){
	try{
		const user=await requireTermsAccount();
		const documents=await getLegalAcceptanceStatus(user.id);
		const terms=documents.find(document=>document.documentKey==='TERMS_AND_CONDITIONS');
		return NextResponse.json({
			version:terms?.version||CURRENT_TERMS_VERSION,
			accepted:documents.every(document=>document.accepted),
			acceptedAt:terms?.acceptedAt??null,
			documents,
			outstanding:documents.filter(document=>!document.accepted),
		},{headers:privateHeaders});
	}catch(error){
		const status=authFailureStatus(error);
		if(status)return NextResponse.json({error:status===401?'Unauthorized':'Forbidden'},{status});
		console.error('Current legal acceptance status could not be loaded.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'Legal acceptance status is temporarily unavailable.'},{status:503,headers:privateHeaders});
	}
}

export async function POST(request:Request){
	try{
		if(!isSameOriginRequest(request))return NextResponse.json({error:'A same-origin request is required.'},{status:403});
		const user=await requireTermsAccount();
		let payload:unknown;
		try{payload=await request.json()}
		catch{return NextResponse.json({error:'Confirm acceptance of the current legal documents.'},{status:400,headers:privateHeaders})}
		const input=acceptanceSchema.parse(payload);
		const current=await getCurrentLegalDocuments();
		const submitted='documents' in input
			?input.documents
			:[{documentKey:'TERMS_AND_CONDITIONS',version:input.version}];
		if(new Set(submitted.map(item=>item.documentKey)).size!==submitted.length){
			return NextResponse.json({error:'Each legal document may be accepted only once per submission.'},{status:400,headers:privateHeaders});
		}
		const acceptedDocuments:Pick<CurrentLegalDocument,'documentKey'|'version'>[]=[];
		for(const item of submitted){
			const document=current.find(candidate=>candidate.documentKey===item.documentKey);
			if(!document||document.version!==item.version){
				return NextResponse.json({error:'A legal document has changed. Review the current version before accepting.'},{status:409,headers:privateHeaders});
			}
			acceptedDocuments.push({documentKey:document.documentKey,version:document.version});
		}
		const acceptedAt=new Date();
		await db.$transaction(async tx=>{
			await recordLegalAcceptances(tx,user.id,acceptedDocuments,acceptedAt,'policy-consent');
		});
		const refreshed=await getLegalAcceptanceStatus(user.id);
		return NextResponse.json({
			accepted:refreshed.every(document=>document.accepted),
			documents:refreshed,
			outstanding:refreshed.filter(document=>!document.accepted),
		},{headers:privateHeaders});
	}catch(error){
		const status=authFailureStatus(error);
		if(status)return NextResponse.json({error:status===401?'Unauthorized':'Forbidden'},{status});
		if(error instanceof ZodError)return NextResponse.json({error:'Confirm acceptance of the current legal documents.'},{status:400,headers:privateHeaders});
		console.error('Legal acceptance could not be saved.',error instanceof Error?error.name:'UnknownError');
		return NextResponse.json({error:'We could not save your acceptance. Please try again.'},{status:503,headers:privateHeaders});
	}
}
