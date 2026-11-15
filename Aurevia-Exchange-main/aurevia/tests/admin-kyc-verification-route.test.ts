import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireAdmin:vi.fn(),
	transaction:vi.fn(),
	caseFindUnique:vi.fn(),
	caseFindFirst:vi.fn(),
	caseUpdateMany:vi.fn(),
	eventCreate:vi.fn(),
	documentFindMany:vi.fn(),
	documentUpdateMany:vi.fn(),
	userFindUniqueOrThrow:vi.fn(),
	userUpdate:vi.fn(),
	auditCreate:vi.fn(),
	createNotification:vi.fn(),
	enqueueKycEmail:vi.fn(),
	synchronizeCompletedProfileTier:vi.fn(),
	promoteApprovedKycCaseToTierThree:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireAdmin:mocks.requireAdmin}));
vi.mock('@/lib/db',()=>({db:{$transaction:mocks.transaction}}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification}));
vi.mock('@/lib/kyc-email-outbox',()=>({enqueueKycEmail:mocks.enqueueKycEmail}));
vi.mock('@/lib/tier-progression',()=>({synchronizeCompletedProfileTier:mocks.synchronizeCompletedProfileTier}));
vi.mock('@/lib/kyc-tier-promotion',()=>({promoteApprovedKycCaseToTierThree:mocks.promoteApprovedKycCaseToTierThree}));

import {PATCH} from '@/app/api/admin/kyc/verifications/[id]/route';

function request(body:unknown){
	return new Request('http://localhost/api/admin/kyc/verifications/case-1',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
}

describe('administrator first-party KYC case decisions',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireAdmin.mockResolvedValue({id:'admin-1'});
		mocks.caseFindUnique.mockResolvedValue({id:'case-1',userId:'user-1',status:'PENDING_REVIEW',documentType:'PASSPORT',assignedToId:null,createdAt:new Date('2026-11-15T10:00:00Z'),updatedAt:new Date('2026-11-15T10:00:00Z')});
		mocks.caseFindFirst.mockResolvedValue({id:'case-1'});
		mocks.caseUpdateMany.mockResolvedValue({count:1});
		mocks.eventCreate.mockResolvedValue({});
		mocks.documentFindMany.mockResolvedValue([
			{id:'front-1',kind:'IDENTITY_DOCUMENT',documentSide:'FRONT',status:'SUBMITTED'},
			{id:'selfie-1',kind:'SELFIE',documentSide:'SELFIE',status:'SUBMITTED'},
		]);
		mocks.documentUpdateMany.mockResolvedValue({count:2});
		mocks.userFindUniqueOrThrow.mockResolvedValue({id:'user-1',name:'Customer Example',country:'US',phone:null,status:'ACTIVE',role:'USER',accountMode:'REAL',kycStatus:'PENDING',approvedTier:2});
		mocks.userUpdate.mockResolvedValue({});
		mocks.auditCreate.mockResolvedValue({});
		mocks.createNotification.mockResolvedValue({});
		mocks.enqueueKycEmail.mockResolvedValue(undefined);
		mocks.synchronizeCompletedProfileTier.mockResolvedValue(false);
		mocks.promoteApprovedKycCaseToTierThree.mockResolvedValue(false);
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({
			kycVerification:{findUnique:mocks.caseFindUnique,findFirst:mocks.caseFindFirst,updateMany:mocks.caseUpdateMany},
			kycVerificationEvent:{create:mocks.eventCreate},
			kycDocument:{findMany:mocks.documentFindMany,updateMany:mocks.documentUpdateMany},
			user:{findUniqueOrThrow:mocks.userFindUniqueOrThrow,update:mocks.userUpdate},
			auditLog:{create:mocks.auditCreate},
			tierUpgradeRequest:{updateMany:vi.fn()},
		}));
	});

	it('records an explicitly confirmed review with the tier and notification outcome in the same transaction',async()=>{
		const response=await PATCH(request({decision:'APPROVE',confirmed:true}),{params:Promise.resolve({id:'case-1'})});

		expect(response.status).toBe(200);
		expect(mocks.caseUpdateMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({id:'case-1',status:'PENDING_REVIEW'})}));
		expect(mocks.documentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({status:'APPROVED'})}));
		expect(mocks.userUpdate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({kycStatus:'APPROVED'})}));
		expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({actorId:'admin-1',action:'KYC_VERIFICATION_APPROVE'})}));
		expect(mocks.createNotification).toHaveBeenCalledOnce();
		expect(mocks.enqueueKycEmail).toHaveBeenCalledWith(expect.anything(),'user-1','VERIFICATION_APPROVED','kyc-verification:case-1:approved');
	});

	it('does not repeat a decision when the conditional state update loses a race',async()=>{
		mocks.caseUpdateMany.mockResolvedValue({count:0});

		const response=await PATCH(request({decision:'APPROVE',confirmed:true}),{params:Promise.resolve({id:'case-1'})});

		expect(response.status).toBe(409);
		expect(mocks.userUpdate).not.toHaveBeenCalled();
		expect(mocks.createNotification).not.toHaveBeenCalled();
	});

	it('does not approve a national identity case without both required document sides',async()=>{
		mocks.caseFindUnique.mockResolvedValue({id:'case-1',userId:'user-1',status:'PENDING_REVIEW',documentType:'NATIONAL_ID',createdAt:new Date('2026-11-15T10:00:00Z'),updatedAt:new Date('2026-11-15T10:00:00Z')});

		const response=await PATCH(request({decision:'APPROVE',confirmed:true}),{params:Promise.resolve({id:'case-1'})});

		expect(response.status).toBe(409);
		expect(mocks.caseUpdateMany).not.toHaveBeenCalled();
		expect(mocks.userUpdate).not.toHaveBeenCalled();
	});

	it('requires a customer-facing reason and selected evidence for resubmission',async()=>{
		const response=await PATCH(request({decision:'RESUBMISSION_REQUIRED',confirmed:true,reason:'',documentIds:[]}),{params:Promise.resolve({id:'case-1'})});

		expect(response.status).toBe(400);
		expect(mocks.caseUpdateMany).not.toHaveBeenCalled();
	});

	it('does not write a decision when the reviewer lacks admin authorization',async()=>{
		mocks.requireAdmin.mockRejectedValue(new Error('FORBIDDEN'));

		const response=await PATCH(request({decision:'APPROVE',confirmed:true}),{params:Promise.resolve({id:'case-1'})});

		expect(response.status).toBe(403);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it('assigns the review case to the authenticated administrator with an audit event',async()=>{
		const response=await PATCH(request({decision:'ASSIGN_TO_ME',confirmed:true}),{params:Promise.resolve({id:'case-1'})});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({assignedToId:'admin-1'});
		expect(mocks.caseUpdateMany).toHaveBeenCalledWith(expect.objectContaining({data:{assignedToId:'admin-1'}}));
		expect(mocks.eventCreate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({action:'ASSIGNED_TO_REVIEWER',actorId:'admin-1'})}));
		expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({action:'KYC_VERIFICATION_ASSIGNED'})}));
		expect(mocks.userUpdate).not.toHaveBeenCalled();
	});

	it('requires explicit decision confirmation',async()=>{
		const response=await PATCH(request({decision:'APPROVE',confirmed:false}),{params:Promise.resolve({id:'case-1'})});

		expect(response.status).toBe(400);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});
});
