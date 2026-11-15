import {createHmac} from 'node:crypto';
import {KycVerificationStatus,Prisma} from '@prisma/client';
import {getServerConfiguration} from '@/lib/config/env';
import {db} from '@/lib/db';
import {deletePrivateObject} from '@/lib/private-storage';

const evidenceRetentionMs=90*24*60*60*1000;
const metadataRetentionYears=7;
const purgeLeaseMs=15*60*1000;
const baseRetryMs=15*60*1000;
const maxRetryMs=24*60*60*1000;
const retainedEvidenceKinds:string[]=['IDENTITY_DOCUMENT','SELFIE'];

export function isKycEvidencePurgeEligible(status:string,decidedAt:Date|null,now=new Date()){
	return (status==='APPROVED'||status==='REJECTED')&&decidedAt!==null&&decidedAt.getTime()+evidenceRetentionMs<=now.getTime();
}

export function pseudonymizeKycReference(value:string){
	const secret=getServerConfiguration().auth.secret;
	if(secret.length<32)throw new Error('KYC_RETENTION_PSEUDONYM_KEY_UNAVAILABLE');
	return createHmac('sha256',secret).update(value).digest('hex');
}

function addRetentionYears(date:Date,years:number){
	const retainedUntil=new Date(date);
	retainedUntil.setUTCFullYear(retainedUntil.getUTCFullYear()+years);
	return retainedUntil;
}

function retryDelay(attempt:number){
	return Math.min(maxRetryMs,baseRetryMs*2**Math.min(Math.max(attempt-1,0),10));
}

function retentionFailureCode(error:unknown){
	if(error instanceof Error&&error.message==='PRIVATE_STORAGE_CLEANUP_FAILED')return 'PRIVATE_STORAGE_CLEANUP_FAILED';
	if(error&&typeof error==='object'&&'code' in error&&['P2002','P2025','P2034'].includes(String(error.code)))return 'DATABASE_RETRY';
	return 'RETENTION_PROCESSING_FAILED';
}

type ClaimedCase={id:string;userId:string;status:KycVerificationStatus;reviewedAt:Date|null;submittedAt:Date|null;reviewedById:string|null;lockedAt:Date};

async function claimEvidenceCases(caseId:string,now:Date){
	return db.$transaction(async tx=>{
		const root=await tx.kycVerification.findUnique({
			where:{id:caseId},
			select:{id:true,userId:true,status:true,reviewedAt:true,submittedAt:true,reviewedById:true,supersedesId:true,legalHoldAt:true,evidencePurgeLockedAt:true,evidencePurgeNextAttemptAt:true},
		});
		if(!root||!isKycEvidencePurgeEligible(root.status,root.reviewedAt,now)||root.legalHoldAt||root.evidencePurgeNextAttemptAt&&root.evidencePurgeNextAttemptAt>now)return null;
		const cases:ClaimedCase[]=[];
		const seen=new Set<string>();
		let current:typeof root|null=root;
		while(current){
			if(seen.has(current.id))throw new Error('KYC_RETENTION_LINEAGE_CYCLE');
			seen.add(current.id);
			if(current.legalHoldAt||current.evidencePurgeNextAttemptAt&&current.evidencePurgeNextAttemptAt>now
				||current.evidencePurgeLockedAt&&current.evidencePurgeLockedAt.getTime()>now.getTime()-purgeLeaseMs)return null;
			if(current.id!==root.id&&current.status!=='CANCELLED')return null;
			cases.push({id:current.id,userId:current.userId,status:current.status,reviewedAt:current.reviewedAt,submittedAt:current.submittedAt,reviewedById:current.reviewedById,lockedAt:now});
			current=current.supersedesId
				?await tx.kycVerification.findUnique({where:{id:current.supersedesId},select:{id:true,userId:true,status:true,reviewedAt:true,submittedAt:true,reviewedById:true,supersedesId:true,legalHoldAt:true,evidencePurgeLockedAt:true,evidencePurgeNextAttemptAt:true}})
				:null;
		}
		if(cases.some(item=>item.userId!==root.userId))throw new Error('KYC_RETENTION_LINEAGE_MISMATCH');
		for(const item of cases){
			const claimed=await tx.kycVerification.updateMany({
				where:{id:item.id,status:item.status,reviewedAt:item.reviewedAt,legalHoldAt:null,OR:[{evidencePurgeLockedAt:null},{evidencePurgeLockedAt:{lte:new Date(now.getTime()-purgeLeaseMs)}}]},
				data:{evidencePurgeLockedAt:now,evidencePurgeAttempts:{increment:1},evidencePurgeNextAttemptAt:null},
			});
			if(claimed.count!==1)throw new Error('KYC_RETENTION_CLAIM_LOST');
		}
		return cases;
	},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

async function refreshEvidenceClaim(item:ClaimedCase){
	const lockedAt=new Date();
	const refreshed=await db.kycVerification.updateMany({
		where:{id:item.id,status:item.status,reviewedAt:item.reviewedAt,legalHoldAt:null,evidencePurgeLockedAt:item.lockedAt},
		data:{evidencePurgeLockedAt:lockedAt},
	});
	if(refreshed.count!==1)throw new Error('KYC_RETENTION_CLAIM_LOST');
	item.lockedAt=lockedAt;
}

async function archivePurgedEvidence(cases:ClaimedCase[],deletedDocumentIds:string[][],now:Date){
	const ids=cases.map(item=>item.id);
	await db.$transaction(async tx=>{
		const currentCases=await tx.kycVerification.findMany({
			where:{id:{in:ids},legalHoldAt:null,OR:cases.map(item=>({id:item.id,evidencePurgeLockedAt:item.lockedAt}))},
			select:{id:true,userId:true,status:true,submittedAt:true,reviewedById:true,events:{select:{actorId:true,action:true,fromStatus:true,toStatus:true,reason:true,createdAt:true}}},
		});
		if(currentCases.length!==cases.length)throw new Error('KYC_RETENTION_CLAIM_LOST');
		const documents=await tx.kycDocument.findMany({
			where:{verificationId:{in:ids},kind:{in:retainedEvidenceKinds}},
			select:{id:true,verificationId:true,userId:true},
		});
		const expectedDocuments=deletedDocumentIds.flat();
		if(documents.length!==expectedDocuments.length||documents.some(document=>
			!expectedDocuments.includes(document.id)||document.userId!==cases.find(item=>item.id===document.verificationId)?.userId)){
			throw new Error('KYC_RETENTION_DOCUMENT_SET_CHANGED');
		}
		const documentIds=expectedDocuments;
		const auditLogs=await tx.auditLog.findMany({
			where:{OR:[
				{entity:'KYC_VERIFICATION',entityId:{in:ids}},
					...(documentIds.length?[{entity:'KYC_DOCUMENT',entityId:{in:documentIds}}]:[]),
			]},
			select:{id:true,actorId:true,action:true,entity:true,entityId:true,createdAt:true},
		});
		const root=cases[0];
		const finalDecisionAt=root.reviewedAt;
		const finalStatus=root.status;
		if(!finalDecisionAt||(finalStatus!=='APPROVED'&&finalStatus!=='REJECTED'))throw new Error('KYC_RETENTION_FINAL_DECISION_MISSING');
		const applicantReference=pseudonymizeKycReference(root.userId);
		for(const item of cases){
			const caseData=currentCases.find(candidate=>candidate.id===item.id);
			if(!caseData)throw new Error('KYC_RETENTION_CASE_MISSING');
			const caseEvents=caseData.events.map(event=>({
				verificationId:item.id,
				actorReference:event.actorId?pseudonymizeKycReference(event.actorId):null,
				action:event.action.slice(0,64),
				fromStatus:event.fromStatus,
				toStatus:event.toStatus,
				reason:event.action.startsWith('LEGAL_HOLD_')?event.reason:null,
				createdAt:event.createdAt,
			}));
			const linkedAuditLogs=auditLogs.filter(log=>
				(log.entity==='KYC_VERIFICATION'&&log.entityId===item.id)||
				(log.entity==='KYC_DOCUMENT'&&documents.some(document=>document.id===log.entityId&&document.verificationId===item.id)));
			const auditEvents=linkedAuditLogs.map(log=>({
				verificationId:item.id,
				actorReference:log.actorId?pseudonymizeKycReference(log.actorId):null,
				action:log.action.slice(0,64),
				fromStatus:null,
				toStatus:null,
				reason:null,
				createdAt:log.createdAt,
			}));
			await tx.kycVerificationArchive.create({data:{
				verificationId:item.id,
				applicantReference,
				decisionStatus:finalStatus,
				decisionCategory:item.id===root.id?finalStatus:`RESUBMITTED_${finalStatus}`,
				reviewerReference:root.reviewedById?pseudonymizeKycReference(root.reviewedById):null,
				submittedAt:caseData.submittedAt,
				decidedAt:finalDecisionAt,
				evidencePurgedAt:now,
				evidencePurgeOutcome:'EVIDENCE_AND_DOCUMENT_ROWS_DELETED',
				retainUntil:addRetentionYears(finalDecisionAt,metadataRetentionYears),
			}});
			const retentionEvents=[...caseEvents,...auditEvents];
			if(retentionEvents.length)await tx.kycRetentionEvent.createMany({data:retentionEvents});
		}
		if(documentIds.length){
			const deleted=await tx.kycDocument.deleteMany({where:{id:{in:documentIds},verificationId:{in:ids},kind:{in:retainedEvidenceKinds}}});
			if(deleted.count!==documentIds.length)throw new Error('KYC_RETENTION_DOCUMENT_SET_CHANGED');
		}
		if(auditLogs.length)await tx.auditLog.deleteMany({where:{id:{in:auditLogs.map(log=>log.id)}}});
		const deletedCases=await tx.kycVerification.deleteMany({where:{id:{in:ids},legalHoldAt:null,OR:cases.map(item=>({id:item.id,evidencePurgeLockedAt:item.lockedAt}))}});
		if(deletedCases.count!==ids.length)throw new Error('KYC_RETENTION_CLAIM_LOST');
	},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

async function unlockForRetry(cases:ClaimedCase[],now:Date,error:unknown){
	const ids=cases.map(item=>item.id);
	const root=cases[0];
	const attempt=await db.kycVerification.findUnique({where:{id:root.id},select:{evidencePurgeAttempts:true}});
	await db.kycVerification.updateMany({
		where:{id:{in:ids},OR:cases.map(item=>({id:item.id,evidencePurgeLockedAt:item.lockedAt}))},
		data:{
			evidencePurgeLockedAt:null,
			evidencePurgeNextAttemptAt:new Date(now.getTime()+retryDelay(attempt?.evidencePurgeAttempts||1)),
			evidencePurgeErrorCode:retentionFailureCode(error),
			evidencePurgeFailedAt:now,
		},
	});
}

async function purgeExpiredArchiveRecords(now:Date,limit:number){
	const candidates=await db.kycVerificationArchive.findMany({
		where:{
			retainUntil:{lte:now},
			legalHoldAt:null,
			AND:[
				{OR:[{retentionPurgeNextAttemptAt:null},{retentionPurgeNextAttemptAt:{lte:now}}]},
				{OR:[{retentionPurgeLockedAt:null},{retentionPurgeLockedAt:{lte:new Date(now.getTime()-purgeLeaseMs)}}]},
			],
		},
		orderBy:{retainUntil:'asc'},
		take:limit,
		select:{verificationId:true},
	});
	let purged=0;
	let retriesScheduled=0;
	for(const candidate of candidates){
		try{
			await db.$transaction(async tx=>{
				const claim=await tx.kycVerificationArchive.updateMany({
					where:{verificationId:candidate.verificationId,legalHoldAt:null,retainUntil:{lte:now},OR:[{retentionPurgeLockedAt:null},{retentionPurgeLockedAt:{lte:new Date(now.getTime()-purgeLeaseMs)}}]},
					data:{retentionPurgeLockedAt:now,retentionPurgeAttempts:{increment:1},retentionPurgeNextAttemptAt:null},
				});
				if(claim.count!==1)return;
				const removed=await tx.kycVerificationArchive.deleteMany({where:{verificationId:candidate.verificationId,legalHoldAt:null,retentionPurgeLockedAt:now}});
				if(removed.count===1)purged++;
			},{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
		}catch(error){
			try{
				const archive=await db.kycVerificationArchive.findUnique({where:{verificationId:candidate.verificationId},select:{retentionPurgeAttempts:true}});
				if(archive){
					const retry=await db.kycVerificationArchive.updateMany({
						where:{verificationId:candidate.verificationId,legalHoldAt:null,retentionPurgeLockedAt:null},
						data:{
							retentionPurgeAttempts:{increment:1},
							retentionPurgeNextAttemptAt:new Date(now.getTime()+retryDelay((archive.retentionPurgeAttempts||0)+1)),
							retentionPurgeErrorCode:retentionFailureCode(error),
							retentionPurgeFailedAt:now,
						},
					});
					if(retry.count===1)retriesScheduled++;
				}
			}catch(retryError){
				console.error('KYC metadata retention retry could not be scheduled.',{errorType:retryError instanceof Error?retryError.name:'UnknownError'});
			}
			console.error('KYC metadata retention attempt failed.',{errorType:error instanceof Error?error.name:'UnknownError',failureCode:retentionFailureCode(error)});
		}
	}
	return {purged,retriesScheduled};
}

export async function processKycRetentionBatch(limit=10,now=new Date()){
	if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('KYC_RETENTION_BATCH_SIZE_INVALID');
	const cutoff=new Date(now.getTime()-evidenceRetentionMs);
	const candidates=await db.kycVerification.findMany({
		where:{
			status:{in:['APPROVED','REJECTED']},
			reviewedAt:{lte:cutoff},
			legalHoldAt:null,
			AND:[
				{OR:[{evidencePurgeNextAttemptAt:null},{evidencePurgeNextAttemptAt:{lte:now}}]},
				{OR:[{evidencePurgeLockedAt:null},{evidencePurgeLockedAt:{lte:new Date(now.getTime()-purgeLeaseMs)}}]},
			],
		},
		orderBy:{reviewedAt:'asc'},
		take:limit,
		select:{id:true},
	});
	let evidencePurged=0;
	let retriesScheduled=0;
	for(const candidate of candidates){
		let claimed:ClaimedCase[]|null=null;
		try{
			claimed=await claimEvidenceCases(candidate.id,now);
			if(!claimed)continue;
			const deletedDocumentIds:string[][]=[];
			for(const item of claimed){
				const documents=await db.kycDocument.findMany({
					where:{verificationId:item.id,kind:{in:retainedEvidenceKinds}},
					select:{id:true,verificationId:true,userId:true,storageKey:true},
				});
				const deletedIds:string[]=[];
				for(const document of documents){
					if(document.verificationId!==item.id||document.userId!==item.userId)throw new Error('KYC_RETENTION_DOCUMENT_OWNER_MISMATCH');
					await refreshEvidenceClaim(item);
					if(!await deletePrivateObject('kyc',document.userId,document.storageKey))throw new Error('PRIVATE_STORAGE_CLEANUP_FAILED');
					deletedIds.push(document.id);
				}
				deletedDocumentIds.push(deletedIds);
			}
			for(const item of claimed)await refreshEvidenceClaim(item);
			await archivePurgedEvidence(claimed,deletedDocumentIds,now);
			evidencePurged+=claimed.length;
		}catch(error){
			if(claimed?.length){
				try{
					await unlockForRetry(claimed,now,error);
					retriesScheduled++;
				}catch(unlockError){
					console.error('KYC evidence retention retry could not be scheduled.',{errorType:unlockError instanceof Error?unlockError.name:'UnknownError'});
				}
			}
			console.error('KYC evidence retention attempt failed.',{errorType:error instanceof Error?error.name:'UnknownError',failureCode:retentionFailureCode(error)});
		}
	}
	const metadata=await purgeExpiredArchiveRecords(now,limit);
	retriesScheduled+=metadata.retriesScheduled;
	console.info('KYC retention batch completed.',{evidencePurged,metadataPurged:metadata.purged,retriesScheduled});
	return {candidates:candidates.length,evidencePurged,metadataPurged:metadata.purged,retriesScheduled};
}
