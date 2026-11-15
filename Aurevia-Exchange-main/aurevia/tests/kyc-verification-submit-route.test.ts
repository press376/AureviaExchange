import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	requireUser:vi.fn(),
	rateLimit:vi.fn(),
	userFindUnique:vi.fn(),
	transaction:vi.fn(),
	caseFindFirst:vi.fn(),
	caseCreate:vi.fn(),
	caseUpdateMany:vi.fn(),
	eventCreate:vi.fn(),
	documentCreate:vi.fn(),
	validateKycImage:vi.fn(),
	createPrivateObjectKey:vi.fn(),
	uploadPrivateObject:vi.fn(),
	deletePrivateObject:vi.fn(),
	createNotification:vi.fn(),
	notifyActiveAdmins:vi.fn(),
	enqueueKycEmail:vi.fn(),
}));

vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/db',()=>({db:{user:{findUnique:mocks.userFindUnique},$transaction:mocks.transaction}}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit}));
vi.mock('@/lib/kyc-verification',async importOriginal=>{
	const original=await importOriginal<typeof import('@/lib/kyc-verification')>();
	return {...original,validateKycImage:mocks.validateKycImage};
});
vi.mock('@/lib/private-storage',()=>({
	createPrivateObjectKey:mocks.createPrivateObjectKey,
	uploadPrivateObject:mocks.uploadPrivateObject,
	deletePrivateObject:mocks.deletePrivateObject,
	PrivateStorageError:class PrivateStorageError extends Error{status=503},
}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification,notifyActiveAdmins:mocks.notifyActiveAdmins}));
vi.mock('@/lib/kyc-email-outbox',()=>({enqueueKycEmail:mocks.enqueueKycEmail}));

import {POST} from '@/app/api/kyc/verification/route';

function submissionRequest(extra?:[string,string|File][]){
	const form=new FormData();
	form.set('documentCountry','US');
	form.set('documentType','PASSPORT');
	form.set('consent','true');
	form.set('documentFront',new File(['front'],'front.png',{type:'image/png'}));
	form.set('selfie',new File(['selfie'],'selfie.png',{type:'image/png'}));
	for(const [key,value] of extra||[])form.append(key,value);
	return new Request('http://localhost/api/kyc/verification',{method:'POST',body:form});
}

describe('first-party KYC submission route',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1'});
		mocks.rateLimit.mockReturnValue(undefined);
		mocks.userFindUnique.mockResolvedValue({id:'user-1',name:'Customer Example',country:'United States',phone:null,status:'ACTIVE',accountMode:'REAL',approvedTier:2,kycStatus:'PENDING',kycDocuments:[],kyc:{submittedAt:null}});
		mocks.caseFindFirst.mockResolvedValue(null);
		mocks.caseCreate.mockResolvedValue({id:'case-1'});
		mocks.caseUpdateMany.mockResolvedValue({count:1});
		mocks.eventCreate.mockResolvedValue({});
		mocks.documentCreate.mockImplementation(async({data}:{data:{kind:string;documentSide:string}})=>({id:`${data.kind}-${data.documentSide}`}));
		mocks.validateKycImage.mockImplementation(async(_file:File,side:string)=>({bytes:Buffer.from(side),mime:'image/png',width:640,height:480,sha256:'a'.repeat(64)}));
		let key=0;
		mocks.createPrivateObjectKey.mockImplementation(()=>`user-1/${++key}.png`);
		mocks.uploadPrivateObject.mockResolvedValue(undefined);
		mocks.deletePrivateObject.mockResolvedValue(true);
		mocks.createNotification.mockResolvedValue({});
		mocks.notifyActiveAdmins.mockResolvedValue(undefined);
		mocks.enqueueKycEmail.mockResolvedValue(undefined);
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({
			kycVerification:{findFirst:mocks.caseFindFirst,create:mocks.caseCreate,updateMany:mocks.caseUpdateMany},
			kycVerificationEvent:{create:mocks.eventCreate},
			kycDocument:{create:mocks.documentCreate},
		}));
	});

	it('stores the identity images in private storage and submits the case for manual review',async()=>{
		const response=await POST(submissionRequest());
		const body=await response.json();

		expect(response.status).toBe(201);
		expect(body).toMatchObject({id:'case-1',status:'PENDING_REVIEW'});
		expect(mocks.uploadPrivateObject).toHaveBeenCalledTimes(2);
		expect(mocks.caseCreate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({
			status:'DRAFT',documentCountry:'US',documentType:'PASSPORT',consentVersion:'aurevia-verify-2026-11',
			assessment:expect.objectContaining({riskLevel:'MANUAL_REVIEW_REQUIRED'}),
		})}));
		expect(mocks.caseUpdateMany).toHaveBeenCalledTimes(3);
		expect(mocks.eventCreate).toHaveBeenCalledTimes(3);
		expect(mocks.createNotification).toHaveBeenCalledOnce();
		expect(mocks.notifyActiveAdmins).toHaveBeenCalledOnce();
		expect(mocks.enqueueKycEmail).toHaveBeenCalledWith(expect.anything(),'user-1','VERIFICATION_SUBMITTED','kyc-verification:case-1:submitted');
	});

	it('links a resubmission to the earlier case for final-decision-based retention',async()=>{
		mocks.caseFindFirst
			.mockResolvedValueOnce({status:'RESUBMISSION_REQUIRED'})
			.mockResolvedValueOnce({id:'case-prior',status:'RESUBMISSION_REQUIRED'});

		const response=await POST(submissionRequest());

		expect(response.status).toBe(201);
		expect(mocks.caseUpdateMany).toHaveBeenCalledWith(expect.objectContaining({where:{id:'case-prior',status:'RESUBMISSION_REQUIRED'},data:{status:'CANCELLED'}}));
		expect(mocks.caseCreate).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({supersedesId:'case-prior'})}));
	});

	it('rejects unknown client fields rather than accepting client-supplied case status',async()=>{
		const response=await POST(submissionRequest([['status','APPROVED']]));

		expect(response.status).toBe(400);
		expect(mocks.uploadPrivateObject).not.toHaveBeenCalled();
		expect(mocks.caseCreate).not.toHaveBeenCalled();
	});

	it('requires the authenticated customer profile before creating evidence',async()=>{
		mocks.userFindUnique.mockResolvedValue({id:'user-1',name:null,country:'United States',phone:null,status:'ACTIVE',accountMode:'REAL',approvedTier:1,kycStatus:'PENDING',kycDocuments:[],kyc:null});

		const response=await POST(submissionRequest());

		expect(response.status).toBe(409);
		expect(mocks.uploadPrivateObject).not.toHaveBeenCalled();
	});
});
