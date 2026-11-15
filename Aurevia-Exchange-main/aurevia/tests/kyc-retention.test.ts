import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>{
	const caseFindUnique=vi.fn();
	const caseUpdateMany=vi.fn();
	const txCaseFindUnique=vi.fn();
	const txCaseFindMany=vi.fn();
	const txCaseUpdateMany=vi.fn();
	const documentFindMany=vi.fn();
	const txDocumentFindMany=vi.fn();
	const archiveCreate=vi.fn();
	const archiveFindMany=vi.fn();
	const retentionEventCreateMany=vi.fn();
	const deletePrivateObject=vi.fn();
	const transaction=vi.fn();
	return {
		caseFindUnique,caseUpdateMany,txCaseFindUnique,txCaseFindMany,txCaseUpdateMany,documentFindMany,txDocumentFindMany,
		archiveCreate,archiveFindMany,retentionEventCreateMany,deletePrivateObject,transaction,
		tx:{
			kycVerification:{findUnique:txCaseFindUnique,findMany:txCaseFindMany,updateMany:txCaseUpdateMany,deleteMany:vi.fn()},
			kycDocument:{findMany:txDocumentFindMany,deleteMany:vi.fn()},
			kycVerificationArchive:{create:archiveCreate,findMany:archiveFindMany,updateMany:vi.fn(),deleteMany:vi.fn()},
			kycRetentionEvent:{createMany:retentionEventCreateMany},
			auditLog:{findMany:vi.fn(),deleteMany:vi.fn()},
		},
	};
});

vi.mock('@/lib/db',()=>({db:{
	$transaction:mocks.transaction,
	kycVerification:{findMany:vi.fn(),findUnique:mocks.caseFindUnique,updateMany:mocks.caseUpdateMany},
	kycDocument:{findMany:mocks.documentFindMany},
	kycVerificationArchive:{findMany:mocks.archiveFindMany},
}}));
vi.mock('@/lib/private-storage',()=>({deletePrivateObject:mocks.deletePrivateObject}));
vi.mock('@/lib/config/env',()=>({getServerConfiguration:()=>({auth:{secret:'retention-test-key-with-more-than-32-bytes'}})}));

import {isKycEvidencePurgeEligible,processKycRetentionBatch,pseudonymizeKycReference} from '@/lib/kyc-retention';
import {db} from '@/lib/db';

const now=new Date('2027-01-01T00:00:00.000Z');
const finalReview=new Date('2026-10-01T00:00:00.000Z');
const submittedAt=new Date('2026-09-01T00:00:00.000Z');

function verification(id:string,status:'APPROVED'|'REJECTED'|'CANCELLED',supersedesId:string|null=null){
	return {
		id,userId:'user-private-1',status,reviewedAt:status==='CANCELLED'?new Date('2026-11-01T00:00:00.000Z'):finalReview,
		submittedAt,reviewedById:'admin-private-1',supersedesId,legalHoldAt:null as Date|null,evidencePurgeLockedAt:null,evidencePurgeNextAttemptAt:null,
		events:[{actorId:'user-private-1',action:'USER_SUBMITTED',fromStatus:'DRAFT',toStatus:'SUBMITTED',reason:'must not be archived',createdAt:submittedAt}],
	};
}

function configureCases(root=verification('case-1','APPROVED'),ancestors:ReturnType<typeof verification>[]=[]){
	vi.mocked(db.kycVerification.findMany).mockResolvedValue([{id:root.id}] as never);
	mocks.txCaseFindUnique.mockImplementation(async({where}:{where:{id:string}})=>[root,...ancestors].find(item=>item.id===where.id)||null);
	mocks.txCaseFindMany.mockResolvedValue([root,...ancestors] as never);
	mocks.txCaseUpdateMany.mockResolvedValue({count:1});
	mocks.caseFindUnique.mockResolvedValue({evidencePurgeAttempts:1});
	mocks.caseUpdateMany.mockResolvedValue({count:1});
	mocks.tx.auditLog.findMany.mockResolvedValue([]);
	mocks.tx.kycVerificationArchive.updateMany.mockResolvedValue({count:1});
	mocks.tx.kycVerificationArchive.deleteMany.mockResolvedValue({count:1});
}

describe('first-party KYC retention',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback(mocks.tx));
		mocks.documentFindMany.mockImplementation(async({where}:{where:{verificationId:string;kind:{in:string[]}}})=>[{id:`doc-${where.verificationId}`,verificationId:where.verificationId,kind:'IDENTITY_DOCUMENT',userId:'user-private-1',storageKey:`user-private-1/${where.verificationId}.png`}]);
		mocks.txDocumentFindMany.mockImplementation(async({where}:{where:{verificationId:{in:string[]}}})=>where.verificationId.in.map(id=>({id:`doc-${id}`,verificationId:id,userId:'user-private-1'})));
		mocks.archiveCreate.mockResolvedValue({});
		mocks.archiveFindMany.mockResolvedValue([]);
		mocks.retentionEventCreateMany.mockResolvedValue({count:1});
		mocks.tx.kycDocument.deleteMany.mockImplementation(async({where}:{where:{id:{in:string[]}}})=>({count:where.id.in.length}));
		mocks.tx.kycVerification.deleteMany.mockImplementation(async({where}:{where:{id:{in:string[]}}})=>({count:where.id.in.length}));
		mocks.deletePrivateObject.mockResolvedValue(true);
		configureCases();
	});

	it('only makes approved or rejected decisions eligible after the full 90 days',()=>{
		const exactlyDue=new Date(now.getTime()-90*24*60*60*1000);
		const oneMillisecondEarly=new Date(exactlyDue.getTime()+1);

		expect(isKycEvidencePurgeEligible('APPROVED',exactlyDue,now)).toBe(true);
		expect(isKycEvidencePurgeEligible('REJECTED',exactlyDue,now)).toBe(true);
		expect(isKycEvidencePurgeEligible('REJECTED',oneMillisecondEarly,now)).toBe(false);
		expect(isKycEvidencePurgeEligible('RESUBMISSION_REQUIRED',exactlyDue,now)).toBe(false);
		expect(isKycEvidencePurgeEligible('PENDING_REVIEW',exactlyDue,now)).toBe(false);
		expect(isKycEvidencePurgeEligible('PROCESSING',exactlyDue,now)).toBe(false);
		expect(isKycEvidencePurgeEligible('ESCALATED',exactlyDue,now)).toBe(false);
	});

	it('deletes private evidence and archives only pseudonymized decision metadata',async()=>{
		mocks.tx.auditLog.findMany.mockResolvedValue([{
			id:'audit-1',actorId:'admin-private-1',action:'KYC_CASE_ACCESSED',entity:'KYC_VERIFICATION',entityId:'case-1',
			metadata:{userId:'user-private-1',email:'private@example.test'},createdAt:submittedAt,
		}]);
		const result=await processKycRetentionBatch(5,now);
		const archived=mocks.archiveCreate.mock.calls[0][0].data;
		const archivedEvents=mocks.retentionEventCreateMany.mock.calls[0][0].data;

		expect(result.evidencePurged).toBe(1);
		expect(mocks.deletePrivateObject).toHaveBeenCalledWith('kyc','user-private-1','user-private-1/case-1.png');
		expect(mocks.documentFindMany.mock.calls[0][0].where.kind.in).toEqual(['IDENTITY_DOCUMENT','SELFIE']);
		expect(archived).toMatchObject({
			verificationId:'case-1',decisionStatus:'APPROVED',decisionCategory:'APPROVED',
			applicantReference:pseudonymizeKycReference('user-private-1'),
			reviewerReference:pseudonymizeKycReference('admin-private-1'),
			evidencePurgeOutcome:'EVIDENCE_AND_DOCUMENT_ROWS_DELETED',
		});
		expect(archived).not.toHaveProperty('userId');
		expect(archivedEvents[0]).toMatchObject({actorReference:pseudonymizeKycReference('user-private-1'),action:'USER_SUBMITTED',reason:null});
		expect(archivedEvents[1]).toMatchObject({actorReference:pseudonymizeKycReference('admin-private-1'),action:'KYC_CASE_ACCESSED'});
		expect(archivedEvents[1]).not.toHaveProperty('metadata');
		expect(mocks.tx.auditLog.deleteMany).toHaveBeenCalledOnce();
		expect(mocks.tx.kycVerification.deleteMany).toHaveBeenCalledOnce();
		expect(mocks.tx.kycDocument.deleteMany).toHaveBeenCalledOnce();
	});

	it('does not purge records when no eligible case is returned, including open or held cases',async()=>{
		vi.mocked(db.kycVerification.findMany).mockResolvedValue([]);

		const result=await processKycRetentionBatch(5,now);

		expect(result).toMatchObject({candidates:0,evidencePurged:0});
		expect(vi.mocked(db.kycVerification.findMany).mock.calls[0][0]).toMatchObject({where:expect.objectContaining({legalHoldAt:null,status:{in:['APPROVED','REJECTED']}})});
		expect(mocks.deletePrivateObject).not.toHaveBeenCalled();
		expect(mocks.archiveCreate).not.toHaveBeenCalled();
	});

	it('deletes expired archive metadata only when the seven-year retention period has elapsed and no hold applies',async()=>{
		vi.mocked(db.kycVerification.findMany).mockResolvedValue([]);
		mocks.archiveFindMany.mockResolvedValueOnce([{verificationId:'archive-1'}] as never);

		const result=await processKycRetentionBatch(5,now);

		expect(result.metadataPurged).toBe(1);
		expect(mocks.tx.kycVerificationArchive.updateMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({verificationId:'archive-1',legalHoldAt:null,retainUntil:{lte:now}}),
		}));
		expect(mocks.tx.kycVerificationArchive.deleteMany).toHaveBeenCalledOnce();
	});

	it('keeps resubmission evidence until its final case is eligible, then archives the full chain',async()=>{
		const previous=verification('case-old','CANCELLED');
		const root=verification('case-new','REJECTED','case-old');
		configureCases(root,[previous]);
		mocks.documentFindMany.mockImplementation(async({where}:{where:{verificationId:string}})=>[{
			id:`doc-${where.verificationId}`,verificationId:where.verificationId,kind:'IDENTITY_DOCUMENT',
			userId:'user-private-1',storageKey:`user-private-1/${where.verificationId}.png`,
		}]);

		const result=await processKycRetentionBatch(5,now);
		const archivedCases=mocks.archiveCreate.mock.calls.map(call=>call[0].data);

		expect(result.evidencePurged).toBe(2);
		expect(mocks.deletePrivateObject).toHaveBeenCalledTimes(2);
		expect(archivedCases.map(item=>item.verificationId)).toEqual(['case-new','case-old']);
		expect(archivedCases[1]).toMatchObject({decisionStatus:'REJECTED',decisionCategory:'RESUBMITTED_REJECTED',decidedAt:finalReview});
	});

	it('does not purge any part of a resubmission chain while a predecessor is on legal hold',async()=>{
		const previous={...verification('case-old','CANCELLED'),legalHoldAt:new Date('2026-12-01T00:00:00Z')};
		const root=verification('case-new','APPROVED','case-old');
		configureCases(root,[previous]);

		const result=await processKycRetentionBatch(5,now);

		expect(result.evidencePurged).toBe(0);
		expect(mocks.txCaseUpdateMany).not.toHaveBeenCalled();
		expect(mocks.deletePrivateObject).not.toHaveBeenCalled();
	});

	it('keeps case rows when storage deletion fails and schedules a retry without archiving',async()=>{
		mocks.deletePrivateObject.mockResolvedValue(false);

		const result=await processKycRetentionBatch(5,now);
		const retryUpdate=mocks.caseUpdateMany.mock.calls.at(-1)?.[0];

		expect(result).toMatchObject({evidencePurged:0,retriesScheduled:1});
		expect(retryUpdate.data).toMatchObject({evidencePurgeLockedAt:null,evidencePurgeErrorCode:'PRIVATE_STORAGE_CLEANUP_FAILED'});
		expect(retryUpdate.data.evidencePurgeNextAttemptAt).toBeInstanceOf(Date);
		expect(mocks.archiveCreate).not.toHaveBeenCalled();
		expect(mocks.tx.kycDocument.deleteMany).not.toHaveBeenCalled();
	});

	it("does not delete another user's document when a row is misassociated with the case",async()=>{
		mocks.documentFindMany.mockResolvedValueOnce([{
			id:'foreign-doc',verificationId:'case-1',kind:'IDENTITY_DOCUMENT',userId:'user-private-2',
			storageKey:'user-private-2/123e4567-e89b-42d3-a456-426614174000.png',
		}] as never);
		const result=await processKycRetentionBatch(5,now);
		expect(result).toMatchObject({evidencePurged:0,retriesScheduled:1});
		expect(mocks.deletePrivateObject).not.toHaveBeenCalled();
		expect(mocks.archiveCreate).not.toHaveBeenCalled();
	});

	it('retries safely after storage deletion when the archive transaction is interrupted',async()=>{
		mocks.archiveCreate.mockRejectedValueOnce(new Error('temporary database failure')).mockResolvedValue({});
		const first=await processKycRetentionBatch(5,now);
		const second=await processKycRetentionBatch(5,new Date(now.getTime()+30*60*1000));
		expect(first).toMatchObject({evidencePurged:0,retriesScheduled:1});
		expect(second.evidencePurged).toBe(1);
		expect(mocks.deletePrivateObject).toHaveBeenCalledTimes(2);
		expect(mocks.tx.kycDocument.deleteMany).toHaveBeenCalledTimes(1);
	});

	it('does not delete evidence when another worker owns the case claim',async()=>{
		mocks.txCaseUpdateMany.mockResolvedValueOnce({count:0});
		const result=await processKycRetentionBatch(5,now);
		expect(result.evidencePurged).toBe(0);
		expect(mocks.deletePrivateObject).not.toHaveBeenCalled();
	});
});
