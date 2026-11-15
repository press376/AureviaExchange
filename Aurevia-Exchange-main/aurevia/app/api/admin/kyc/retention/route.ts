import {Prisma} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';
import {pseudonymizeKycReference} from '@/lib/kyc-retention';
import {isSameOriginRequest} from '@/lib/push-notifications';

const retentionActionSchema=z.object({
	verificationId:z.string().trim().min(1).max(128),
	action:z.enum(['PLACE_HOLD','UPDATE_HOLD','RELEASE_HOLD']),
	reason:z.string().trim().min(3).max(1000),
});
const retentionQuerySchema=z.object({
	page:z.coerce.number().int().min(1).max(10000).default(1),
	pageSize:z.coerce.number().int().min(1).max(50).default(20),
	search:z.string().trim().max(128).default(''),
});

export async function GET(request:Request){
	try{
		await requireAdmin();
		const params=new URL(request.url).searchParams;
		const query=retentionQuerySchema.parse({
			page:params.get('page')||undefined,pageSize:params.get('pageSize')||undefined,search:params.get('search')||'',
		});
		const {page,pageSize}=query;
		const search=query.search;
		const where=search?{verificationId:search}:{};
		const [items,total]=await Promise.all([
			db.kycVerificationArchive.findMany({
				where,orderBy:{decidedAt:'desc'},skip:(page-1)*pageSize,take:pageSize,
				select:{verificationId:true,decisionStatus:true,decisionCategory:true,submittedAt:true,decidedAt:true,evidencePurgedAt:true,evidencePurgeOutcome:true,retainUntil:true,legalHoldAt:true,legalHoldReason:true,retentionPurgeAttempts:true,retentionPurgeNextAttemptAt:true,retentionPurgeErrorCode:true,events:{select:{actorReference:true,action:true,fromStatus:true,toStatus:true,reason:true,createdAt:true},orderBy:{createdAt:'desc'},take:25}},
			}),
			db.kycVerificationArchive.count({where}),
		]);
		return NextResponse.json({items,total,page,pageSize,totalPages:Math.ceil(total/pageSize)},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof ZodError)return NextResponse.json({error:'Use a valid archive page, page size, and exact case ID.'},{status:400});
		console.error('KYC retention archive could not be loaded.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to load retained KYC records.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}

export async function POST(request:Request){
	try{
		const admin=await requireAdmin();
		if(!isSameOriginRequest(request))return NextResponse.json({error:'A same-origin request is required.'},{status:403,headers:{'Cache-Control':'private, no-store'}});
		const input=retentionActionSchema.parse(await request.json());
		const result=await db.$transaction(async tx=>{
			const live=await tx.kycVerification.findUnique({
				where:{id:input.verificationId},
				select:{id:true,status:true,legalHoldAt:true,evidencePurgeLockedAt:true},
			});
			const now=new Date();
			if(live){
				const placing=input.action==='PLACE_HOLD';
				const modifying=input.action==='UPDATE_HOLD';
				if(placing&&live.legalHoldAt)return {verificationId:live.id,legalHoldAt:live.legalHoldAt,alreadyApplied:true};
				if(modifying&&!live.legalHoldAt)throw new Error('KYC_RETENTION_HOLD_NOT_ACTIVE');
				if(!placing&&!live.legalHoldAt)return {verificationId:live.id,legalHoldAt:null,alreadyApplied:true};
				if(live.evidencePurgeLockedAt)throw new Error('KYC_RETENTION_PURGE_IN_PROGRESS');
				const updated=await tx.kycVerification.updateMany({
					where:{id:live.id,legalHoldAt:placing?null:{not:null},evidencePurgeLockedAt:null},
					data:placing
						?{legalHoldAt:now,legalHoldReason:input.reason,legalHoldById:admin.id}
						:modifying
							?{legalHoldReason:input.reason,legalHoldById:admin.id}
							:{legalHoldAt:null,legalHoldReason:null,legalHoldById:null},
				});
				if(updated.count!==1)throw new Error('KYC_RETENTION_HOLD_CHANGED');
				const action=placing?'LEGAL_HOLD_PLACED':modifying?'LEGAL_HOLD_UPDATED':'LEGAL_HOLD_RELEASED';
				await tx.kycVerificationEvent.create({data:{
					verificationId:live.id,actorId:admin.id,fromStatus:live.status,toStatus:live.status,action,reason:input.reason,
				}});
				await tx.auditLog.create({data:{
					actorId:admin.id,action:`KYC_RETENTION_${action}`,entity:'KYC_VERIFICATION',entityId:live.id,metadata:{reason:input.reason},
				}});
				return {verificationId:live.id,legalHoldAt:placing?now:modifying?live.legalHoldAt:null,alreadyApplied:false};
			}

			const archive=await tx.kycVerificationArchive.findUnique({
				where:{verificationId:input.verificationId},
				select:{verificationId:true,decisionStatus:true,legalHoldAt:true,retentionPurgeLockedAt:true},
			});
			if(!archive)throw new Error('KYC_RETENTION_RECORD_NOT_FOUND');
			const placing=input.action==='PLACE_HOLD';
			const modifying=input.action==='UPDATE_HOLD';
			if(placing&&archive.legalHoldAt)return {verificationId:archive.verificationId,legalHoldAt:archive.legalHoldAt,alreadyApplied:true};
			if(modifying&&!archive.legalHoldAt)throw new Error('KYC_RETENTION_HOLD_NOT_ACTIVE');
			if(!placing&&!archive.legalHoldAt)return {verificationId:archive.verificationId,legalHoldAt:null,alreadyApplied:true};
			if(archive.retentionPurgeLockedAt)throw new Error('KYC_RETENTION_PURGE_IN_PROGRESS');
			const updated=await tx.kycVerificationArchive.updateMany({
				where:{verificationId:archive.verificationId,legalHoldAt:placing?null:{not:null},retentionPurgeLockedAt:null},
				data:placing
					?{legalHoldAt:now,legalHoldReason:input.reason,legalHoldActorReference:pseudonymizeKycReference(admin.id)}
					:modifying
						?{legalHoldReason:input.reason,legalHoldActorReference:pseudonymizeKycReference(admin.id)}
						:{legalHoldAt:null,legalHoldReason:null,legalHoldActorReference:null},
			});
			if(updated.count!==1)throw new Error('KYC_RETENTION_HOLD_CHANGED');
			await tx.kycRetentionEvent.create({data:{
				verificationId:archive.verificationId,actorReference:pseudonymizeKycReference(admin.id),action:placing?'LEGAL_HOLD_PLACED':modifying?'LEGAL_HOLD_UPDATED':'LEGAL_HOLD_RELEASED',
				fromStatus:archive.decisionStatus,toStatus:archive.decisionStatus,reason:input.reason,createdAt:now,
			}});
			return {verificationId:archive.verificationId,legalHoldAt:placing?now:modifying?archive.legalHoldAt:null,alreadyApplied:false};
		},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		return NextResponse.json(result,{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof ZodError)return NextResponse.json({error:'Provide a valid case, hold action, and documented reason.'},{status:400});
		if(error instanceof SyntaxError)return NextResponse.json({error:'Retention action data must be valid JSON.'},{status:400});
		if(error instanceof Error&&error.message==='KYC_RETENTION_RECORD_NOT_FOUND')return NextResponse.json({error:'Retained KYC record not found.'},{status:404});
		if(error instanceof Error&&error.message==='KYC_RETENTION_HOLD_NOT_ACTIVE')return NextResponse.json({error:'An active legal hold is required before it can be modified.'},{status:409});
		if((error instanceof Error&&['KYC_RETENTION_PURGE_IN_PROGRESS','KYC_RETENTION_HOLD_CHANGED'].includes(error.message))||(error&&typeof error==='object'&&'code' in error&&['P2002','P2034'].includes(String(error.code))))return NextResponse.json({error:'The retention record is being purged or changed. Refresh and retry if appropriate.'},{status:409});
		console.error('KYC retention legal hold could not be saved.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to update the KYC legal hold.'},{status:503});
	}
}
