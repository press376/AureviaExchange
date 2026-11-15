import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireAdmin:vi.fn(),
	transaction:vi.fn(),
	liveFindUnique:vi.fn(),
	liveUpdateMany:vi.fn(),
	eventCreate:vi.fn(),
	auditCreate:vi.fn(),
	archiveFindUnique:vi.fn(),
	archiveUpdateMany:vi.fn(),
	retentionEventCreate:vi.fn(),
	pseudonymize:vi.fn(),
	archiveListFindMany:vi.fn(),
	archiveCount:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireAdmin:mocks.requireAdmin}));
vi.mock('@/lib/db',()=>({db:{$transaction:mocks.transaction,kycVerificationArchive:{findMany:mocks.archiveListFindMany,count:mocks.archiveCount}}}));
vi.mock('@/lib/kyc-retention',()=>({pseudonymizeKycReference:mocks.pseudonymize}));

import {GET,POST} from '@/app/api/admin/kyc/retention/route';

function request(body:unknown){
	return new Request('http://localhost/api/admin/kyc/retention',{method:'POST',headers:{'content-type':'application/json',origin:'http://localhost'},body:JSON.stringify(body)});
}

describe('administrator KYC retention legal holds',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireAdmin.mockResolvedValue({id:'admin-1'});
		mocks.pseudonymize.mockReturnValue('a'.repeat(64));
		mocks.liveFindUnique.mockResolvedValue({id:'case-1',status:'APPROVED',legalHoldAt:null,evidencePurgeLockedAt:null});
		mocks.liveUpdateMany.mockResolvedValue({count:1});
		mocks.eventCreate.mockResolvedValue({});
		mocks.auditCreate.mockResolvedValue({});
		mocks.archiveFindUnique.mockResolvedValue(null);
		mocks.archiveUpdateMany.mockResolvedValue({count:1});
		mocks.retentionEventCreate.mockResolvedValue({});
		mocks.archiveListFindMany.mockResolvedValue([]);
		mocks.archiveCount.mockResolvedValue(0);
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({
			kycVerification:{findUnique:mocks.liveFindUnique,updateMany:mocks.liveUpdateMany},
			kycVerificationEvent:{create:mocks.eventCreate},
			auditLog:{create:mocks.auditCreate},
			kycVerificationArchive:{findUnique:mocks.archiveFindUnique,updateMany:mocks.archiveUpdateMany},
			kycRetentionEvent:{create:mocks.retentionEventCreate},
		}));
	});

	it('serves pseudonymized historical records only to administrators',async()=>{
		mocks.archiveListFindMany.mockResolvedValueOnce([{
			verificationId:'case-archived',decisionStatus:'APPROVED',decisionCategory:'APPROVED',submittedAt:null,
			decidedAt:new Date('2026-01-01T00:00:00Z'),evidencePurgedAt:new Date('2026-04-01T00:00:00Z'),
			evidencePurgeOutcome:'EVIDENCE_AND_DOCUMENT_ROWS_DELETED',retainUntil:new Date('2033-01-01T00:00:00Z'),
			legalHoldAt:null,legalHoldReason:null,events:[],
		}]);
		mocks.archiveCount.mockResolvedValueOnce(1);

		const response=await GET(new Request('http://localhost/api/admin/kyc/retention?search=case-archived'));
		const body=await response.json();

		expect(response.status).toBe(200);
		expect(body.items[0]).toMatchObject({verificationId:'case-archived',decisionStatus:'APPROVED'});
		expect(body.items[0]).not.toHaveProperty('userId');
		expect(body.items[0]).not.toHaveProperty('applicantReference');
		expect(mocks.archiveListFindMany).toHaveBeenCalledWith(expect.objectContaining({where:{verificationId:'case-archived'}}));

		mocks.requireAdmin.mockRejectedValue(new Error('FORBIDDEN'));
		const forbidden=await GET(new Request('http://localhost/api/admin/kyc/retention'));
		expect(forbidden.status).toBe(403);
	});

	it('requires the server-authorized administrator and a documented reason',async()=>{
		mocks.requireAdmin.mockRejectedValue(new Error('FORBIDDEN'));
		const forbidden=await POST(request({verificationId:'case-1',action:'PLACE_HOLD',reason:'Legal request'}));
		expect(forbidden.status).toBe(403);
		expect(mocks.transaction).not.toHaveBeenCalled();

		mocks.requireAdmin.mockResolvedValue({id:'admin-1'});
		const invalid=await POST(request({verificationId:'case-1',action:'PLACE_HOLD',reason:'x'}));
		expect(invalid.status).toBe(400);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it('records a live-case hold and its authorized actor in the existing case and audit trails',async()=>{
		const response=await POST(request({verificationId:'case-1',action:'PLACE_HOLD',reason:'Documented legal request'}));

		expect(response.status).toBe(200);
		expect(mocks.liveUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			where:{id:'case-1',legalHoldAt:null,evidencePurgeLockedAt:null},
			data:expect.objectContaining({legalHoldReason:'Documented legal request',legalHoldById:'admin-1'}),
		}));
		expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({actorId:'admin-1',action:'LEGAL_HOLD_PLACED',reason:'Documented legal request'})}));
		expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({actorId:'admin-1',action:'KYC_RETENTION_LEGAL_HOLD_PLACED'})}));
	});

	it('records archived-case holds with a pseudonymous actor reference',async()=>{
		mocks.liveFindUnique.mockResolvedValue(null);
		mocks.archiveFindUnique.mockResolvedValue({verificationId:'case-archived',decisionStatus:'REJECTED',legalHoldAt:null,retentionPurgeLockedAt:null});

		const response=await POST(request({verificationId:'case-archived',action:'PLACE_HOLD',reason:'Documented legal request'}));

		expect(response.status).toBe(200);
		expect(mocks.archiveUpdateMany).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({
			legalHoldReason:'Documented legal request',legalHoldActorReference:'a'.repeat(64),
		})}));
		expect(mocks.retentionEventCreate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({
			verificationId:'case-archived',actorReference:'a'.repeat(64),action:'LEGAL_HOLD_PLACED',
		})}));
	});

	it('requires an active hold before changing its documented reason and records the update',async()=>{
		mocks.liveFindUnique.mockResolvedValue({
			id:'case-1',status:'APPROVED',legalHoldAt:new Date('2026-12-01T00:00:00Z'),evidencePurgeLockedAt:null,
		});
		const response=await POST(request({verificationId:'case-1',action:'UPDATE_HOLD',reason:'Updated regulatory preservation request'}));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({legalHoldAt:'2026-12-01T00:00:00.000Z',alreadyApplied:false});
		expect(mocks.liveUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			data:{legalHoldReason:'Updated regulatory preservation request',legalHoldById:'admin-1'},
		}));
		expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({
			data:expect.objectContaining({action:'LEGAL_HOLD_UPDATED',reason:'Updated regulatory preservation request'}),
		}));
	});

	it('rejects cross-origin hold changes',async()=>{
		const crossOrigin=new Request('http://localhost/api/admin/kyc/retention',{
			method:'POST',headers:{'content-type':'application/json',origin:'https://attacker.example'},
			body:JSON.stringify({verificationId:'case-1',action:'PLACE_HOLD',reason:'Documented legal request'}),
		});
		expect((await POST(crossOrigin)).status).toBe(403);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});
});
