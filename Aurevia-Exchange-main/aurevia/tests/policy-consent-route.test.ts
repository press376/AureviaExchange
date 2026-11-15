import {beforeEach,describe,expect,it,vi} from 'vitest';
import {CURRENT_TERMS_VERSION} from '@/lib/policy-consent';

const mocks=vi.hoisted(()=>({
	getServerSession:vi.fn(),
	requireUser:vi.fn(),
	requireAdmin:vi.fn(),
	currentDocuments:vi.fn(),
	acceptanceStatus:vi.fn(),
	recordAcceptances:vi.fn(),
	transaction:vi.fn(),
}));

const documents=[
	{documentKey:'TERMS_AND_CONDITIONS',title:'Terms & Conditions',href:'/terms',version:CURRENT_TERMS_VERSION,requiresReacceptance:true,content:null},
	{documentKey:'PRIVACY_POLICY',title:'Privacy Policy',href:'/privacy',version:'privacy-v1',requiresReacceptance:true,content:null},
	{documentKey:'RISK_DISCLOSURE',title:'Risk Disclosure',href:'/risk-disclosure',version:'risk-v1',requiresReacceptance:true,content:null},
	{documentKey:'AML_KYC_POLICY',title:'AML/KYC Policy',href:'/aml-kyc',version:'aml-v1',requiresReacceptance:true,content:null},
	{documentKey:'DEPOSIT_WITHDRAWAL_POLICY',title:'Deposits and withdrawals',href:'/deposit-withdrawal-policy',version:'funding-v1',requiresReacceptance:true,content:null},
	{documentKey:'PLATFORM_USAGE_POLICY',title:'Platform Usage Policy',href:'/platform-usage',version:'usage-v1',requiresReacceptance:true,content:null},
];

vi.mock('next-auth',()=>({getServerSession:mocks.getServerSession}));
vi.mock('@/lib/auth-options',()=>({authOptions:{}}));
vi.mock('@/lib/auth',()=>({
	authFailureStatus:(error:unknown)=>error instanceof Error&&error.message==='UNAUTHORIZED'?401:error instanceof Error&&error.message==='FORBIDDEN'?403:null,
	requireUser:mocks.requireUser,
	requireAdmin:mocks.requireAdmin,
}));
vi.mock('@/lib/db',()=>({db:{$transaction:mocks.transaction}}));
vi.mock('@/lib/legal-acceptance',()=>({
	getCurrentLegalDocuments:mocks.currentDocuments,
	getLegalAcceptanceStatus:mocks.acceptanceStatus,
	recordLegalAcceptances:mocks.recordAcceptances,
}));

import {GET,POST} from '@/app/api/policy-consent/route';

const acceptanceRequest=(body:unknown,origin='https://aurevia.test')=>new Request('https://aurevia.test/api/policy-consent',{
	method:'POST',
	headers:{'content-type':'application/json',origin},
	body:JSON.stringify(body),
});

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.getServerSession.mockResolvedValue({user:{id:'user-a',role:'USER'}});
	mocks.requireUser.mockResolvedValue({id:'user-a'});
	mocks.requireAdmin.mockResolvedValue({id:'admin-a'});
	mocks.currentDocuments.mockResolvedValue(documents);
	mocks.acceptanceStatus.mockResolvedValue(documents.map(document=>({...document,accepted:false,acceptedAt:null})));
	mocks.recordAcceptances.mockResolvedValue(undefined);
	mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({}));
});

describe('policy consent API',()=>{
	it('reports current-version acceptance for only the authenticated user without caching',async()=>{
		mocks.acceptanceStatus.mockResolvedValue(documents.map(document=>({...document,accepted:true,acceptedAt:new Date('2026-11-10T12:00:00.000Z')})));
		const response=await GET();
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		expect(await response.json()).toMatchObject({
			version:CURRENT_TERMS_VERSION,accepted:true,acceptedAt:'2026-11-10T12:00:00.000Z',outstanding:[],
		});
		expect(mocks.requireUser).toHaveBeenCalledWith({skipTermsAcceptance:true});
	});

	it('reports the current versions that remain outstanding',async()=>{
		const response=await GET();
		const body=await response.json();
		expect(response.status).toBe(200);
		expect(body).toMatchObject({version:CURRENT_TERMS_VERSION,accepted:false,acceptedAt:null});
		expect(body.outstanding).toHaveLength(documents.length);
	});

	it('records acceptance for the authenticated user and current version',async()=>{
		mocks.acceptanceStatus.mockResolvedValueOnce(documents.map(document=>({...document,accepted:true,acceptedAt:new Date('2026-11-10T12:00:00.000Z')})));
		const response=await POST(acceptanceRequest({documents:documents.map(({documentKey,version})=>({documentKey,version})),accepted:true}));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({accepted:true,outstanding:[]});
		expect(mocks.transaction).toHaveBeenCalledOnce();
		expect(mocks.recordAcceptances).toHaveBeenCalledWith(
			expect.anything(),'user-a',documents.map(({documentKey,version})=>({documentKey,version})),
			expect.any(Date),'policy-consent',
		);
	});

	it('allows an authenticated administrator to view their own acceptance status',async()=>{
		mocks.getServerSession.mockResolvedValue({user:{id:'admin-a',role:'ADMIN'}});
		const response=await GET();
		expect(response.status).toBe(200);
		expect(mocks.requireAdmin).toHaveBeenCalledWith({skipTermsAcceptance:true});
		expect(mocks.acceptanceStatus).toHaveBeenCalledWith('admin-a');
	});

	it('rejects unauthenticated requests and never writes an acceptance',async()=>{
		mocks.requireUser.mockRejectedValue(new Error('UNAUTHORIZED'));
		expect((await GET()).status).toBe(401);
		expect((await POST(acceptanceRequest({version:CURRENT_TERMS_VERSION,accepted:true}))).status).toBe(401);
		expect(mocks.recordAcceptances).not.toHaveBeenCalled();
	});

	it('rejects malformed, duplicate, cross-user, and cross-origin submissions',async()=>{
		expect((await POST(acceptanceRequest({version:CURRENT_TERMS_VERSION,accepted:false}))).status).toBe(400);
		expect((await POST(acceptanceRequest({documents:[
			{documentKey:'TERMS_AND_CONDITIONS',version:CURRENT_TERMS_VERSION},
			{documentKey:'TERMS_AND_CONDITIONS',version:CURRENT_TERMS_VERSION},
		],accepted:true}))).status).toBe(400);
		expect((await POST(acceptanceRequest({documents:[],accepted:true,userId:'user-b'}))).status).toBe(400);
		expect((await POST(acceptanceRequest({documents:[{documentKey:'TERMS_AND_CONDITIONS',version:'stale'}],accepted:true}))).status).toBe(409);
		expect((await POST(acceptanceRequest({documents:[{documentKey:'TERMS_AND_CONDITIONS',version:CURRENT_TERMS_VERSION}],accepted:true},'https://attacker.test'))).status).toBe(403);
		expect(mocks.recordAcceptances).not.toHaveBeenCalled();
	});

	it('preserves idempotence when the same current versions are accepted repeatedly',async()=>{
		const body={documents:documents.map(({documentKey,version})=>({documentKey,version})),accepted:true};
		const first=await POST(acceptanceRequest(body));
		const second=await POST(acceptanceRequest(body));
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(mocks.recordAcceptances).toHaveBeenCalledTimes(2);
	});
});
