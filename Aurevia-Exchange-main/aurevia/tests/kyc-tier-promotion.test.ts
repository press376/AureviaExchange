import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	verificationFindFirst:vi.fn(),
	userFindUnique:vi.fn(),
	documentFindMany:vi.fn(),
	userUpdateMany:vi.fn(),
	tierRequestUpdateMany:vi.fn(),
	auditCreate:vi.fn(),
	createNotification:vi.fn(),
	enqueueKycEmail:vi.fn(),
	synchronizeCompletedProfileTier:vi.fn(),
}));

vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification}));
vi.mock('@/lib/kyc-email-outbox',()=>({enqueueKycEmail:mocks.enqueueKycEmail}));
vi.mock('@/lib/tier-progression',()=>({synchronizeCompletedProfileTier:mocks.synchronizeCompletedProfileTier}));

import {promoteApprovedKycCaseToTierThree} from '@/lib/kyc-tier-promotion';

function tx(){
	return {
		kycVerification:{findFirst:mocks.verificationFindFirst},
		user:{findUnique:mocks.userFindUnique,updateMany:mocks.userUpdateMany},
		kycDocument:{findMany:mocks.documentFindMany},
		tierUpgradeRequest:{updateMany:mocks.tierRequestUpdateMany},
		auditLog:{create:mocks.auditCreate},
	} as never;
}

describe('KYC Tier 3 promotion',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.verificationFindFirst.mockResolvedValue({id:'case-1'});
		mocks.userFindUnique.mockResolvedValue({
			id:'user-1',role:'USER',status:'ACTIVE',accountMode:'REAL',approvedTier:2,kycStatus:'APPROVED',
			name:'Customer Example',country:'United States',phone:null,kyc:{address:'100 Main Street'},
			kycDocuments:[{status:'APPROVED'}],
		});
		mocks.documentFindMany.mockResolvedValue([{kind:'IDENTITY_DOCUMENT'},{kind:'SELFIE'}]);
		mocks.userUpdateMany.mockResolvedValue({count:1});
		mocks.tierRequestUpdateMany.mockResolvedValue({count:0});
		mocks.auditCreate.mockResolvedValue({});
		mocks.createNotification.mockResolvedValue({});
		mocks.enqueueKycEmail.mockResolvedValue(undefined);
		mocks.synchronizeCompletedProfileTier.mockResolvedValue(false);
	});

	it('promotes only an approved eligible REAL customer and queues audit and notices transactionally',async()=>{
		await expect(promoteApprovedKycCaseToTierThree(tx(),{
			userId:'user-1',verificationId:'case-1',administratorId:'admin-1',now:new Date('2026-11-15T12:00:00Z'),
		})).resolves.toBe(true);

		expect(mocks.userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({id:'user-1',approvedTier:{lt:3},kycStatus:'APPROVED'}),
			data:{approvedTier:3},
		}));
		expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({
			actorId:'admin-1',action:'KYC_TIER_AUTO_PROMOTED',entityId:'case-1',
		})}));
		expect(mocks.createNotification).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
			dedupeKey:'kyc-verification:case-1:tier3',type:'ACCOUNT',
		}));
		expect(mocks.enqueueKycEmail).toHaveBeenCalledWith(expect.anything(),'user-1','VERIFICATION_TIER3_APPROVED','kyc-verification:case-1:tier3');
	});

	it('does not promote if the proof-of-address prerequisite is missing',async()=>{
		mocks.userFindUnique.mockResolvedValue({
			id:'user-1',role:'USER',status:'ACTIVE',accountMode:'REAL',approvedTier:2,kycStatus:'APPROVED',
			name:'Customer Example',country:'United States',phone:null,kyc:{address:'100 Main Street'},kycDocuments:[],
		});

		await expect(promoteApprovedKycCaseToTierThree(tx(),{
			userId:'user-1',verificationId:'case-1',administratorId:'admin-1',
		})).resolves.toBe(false);

		expect(mocks.userUpdateMany).not.toHaveBeenCalled();
		expect(mocks.auditCreate).not.toHaveBeenCalled();
		expect(mocks.createNotification).not.toHaveBeenCalled();
		expect(mocks.enqueueKycEmail).not.toHaveBeenCalled();
	});

	it('does not promote a Demo or inactive account',async()=>{
		mocks.userFindUnique.mockResolvedValue({
			id:'user-1',role:'USER',status:'FROZEN',accountMode:'DEMO',approvedTier:2,kycStatus:'APPROVED',
			name:'Customer Example',country:'United States',phone:null,kyc:{address:'100 Main Street'},kycDocuments:[{status:'APPROVED'}],
		});

		await expect(promoteApprovedKycCaseToTierThree(tx(),{
			userId:'user-1',verificationId:'case-1',administratorId:'admin-1',
		})).resolves.toBe(false);

		expect(mocks.userUpdateMany).not.toHaveBeenCalled();
	});
});
