import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Prisma} from '@prisma/client';
import bcrypt from 'bcryptjs';

const mocks=vi.hoisted(()=>({
	userFindFirst:vi.fn(),
	transaction:vi.fn(),
	createAccount:vi.fn(),
	waitlistUpdateMany:vi.fn(),
	createNotification:vi.fn(),
	notifyActiveAdmins:vi.fn(),
	trustedProxyClientIp:vi.fn(),
	rateLimit:vi.fn(),
	verifyTurnstileToken:vi.fn(),
	getCurrentLegalDocuments:vi.fn(),
	RateLimitError:class extends Error{
		readonly retryAfterSeconds:number;
		constructor(retryAfterSeconds:number){
			super('RATE_LIMITED');
			this.retryAfterSeconds=retryAfterSeconds;
		}
	},
}));

vi.mock('@/lib/db',()=>({db:{
	user:{findFirst:mocks.userFindFirst},
	waitlistEntry:{updateMany:mocks.waitlistUpdateMany},
	$transaction:mocks.transaction,
}}));
vi.mock('@/lib/rate-limit',()=>({rateLimit:mocks.rateLimit,RateLimitError:mocks.RateLimitError}));
vi.mock('@/lib/request-ip',()=>({trustedProxyClientIp:mocks.trustedProxyClientIp}));
vi.mock('@/lib/registration-attempt',()=>({createImmediateRegistration:mocks.createAccount}));
vi.mock('@/lib/notifications',()=>({createNotification:mocks.createNotification,notifyActiveAdmins:mocks.notifyActiveAdmins}));
vi.mock('@/lib/turnstile',()=>({verifyTurnstileToken:mocks.verifyTurnstileToken}));
vi.mock('@/lib/legal-acceptance',()=>({getCurrentLegalDocuments:mocks.getCurrentLegalDocuments}));

import {POST} from '@/app/api/register/route';

const payload={
	email:'new-user@example.invalid',
	password:'SecureTestPassword1',
	name:'New User',
	country:'United States',
	countryCode:'US',
	gender:'PREFER_NOT_TO_SAY',
	dateOfBirth:'1990-01-01',
	phone:'+12025550123',
	accountMode:'DEMO',
	address:{countryCode:'US',line1:'123 Example Street',city:'New York'},
	legal:{
		termsAccepted:true,privacyAccepted:true,riskDisclosureAccepted:true,
		amlKycAccepted:true,depositWithdrawalAccepted:true,platformUsageAccepted:true,
	},
	legalAcceptances:[
		{documentKey:'TERMS_AND_CONDITIONS',version:'2026-10-27'},
		{documentKey:'PRIVACY_POLICY',version:'privacy'},
		{documentKey:'RISK_DISCLOSURE',version:'2026-10-27'},
		{documentKey:'AML_KYC_POLICY',version:'2026-11-15-v1'},
		{documentKey:'DEPOSIT_WITHDRAWAL_POLICY',version:'2026-11-15-v1'},
		{documentKey:'PLATFORM_USAGE_POLICY',version:'2026-11-15-v1'},
	],
	turnstileToken:'test-turnstile-token',
	website:'',
};

function request(body:unknown=payload,requestId?:string){
	return new Request('https://aurevia.test/api/register',{
		method:'POST',
		headers:{
			'content-type':'application/json',
			'x-forwarded-for':'192.0.2.5',
			...(requestId?{'x-aurevia-request-id':requestId}:{}),
		},
		body:JSON.stringify(body),
	});
}

describe('immediate registration',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		vi.stubEnv('NEXT_PUBLIC_APP_URL','https://aurevia.test');
		mocks.userFindFirst.mockResolvedValue(null);
		mocks.trustedProxyClientIp.mockReturnValue('192.0.2.5');
		mocks.rateLimit.mockReturnValue(undefined);
		mocks.verifyTurnstileToken.mockResolvedValue(undefined);
		mocks.getCurrentLegalDocuments.mockResolvedValue(payload.legalAcceptances.map(document=>({
			...document,title:document.documentKey,href:'/legal-centre',requiresReacceptance:true,content:null,
		})));
		mocks.createAccount.mockResolvedValue({id:'user-1'});
		mocks.waitlistUpdateMany.mockResolvedValue({count:0});
		mocks.createNotification.mockResolvedValue({});
		mocks.notifyActiveAdmins.mockResolvedValue(undefined);
		mocks.transaction.mockImplementation(async(callback:(tx:unknown)=>Promise<unknown>)=>callback({}));
	});

	afterEach(()=>vi.unstubAllEnvs());

	it('creates an active account after server-verified Turnstile without email or phone OTP',async()=>{
		const response=await POST(request(payload,'e75c6069-6dc9-4de5-8a58-e8257d8f8e03'));
		const body=await response.json();

		expect(response.status).toBe(201);
		expect(body).toMatchObject({created:true,email:payload.email,message:'Your account has been created. Signing you in…'});
		expect(body).not.toHaveProperty('verificationRequired');
		expect(JSON.stringify(body)).not.toContain(payload.password);
		expect(mocks.createAccount).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
			email:payload.email,
			passwordHash:expect.any(String),
			name:payload.name,
			gender:payload.gender,
			phone:payload.phone,
			accountMode:'DEMO',
			dateOfBirth:new Date('1990-01-01T00:00:00.000Z'),
			termsAcceptedAt:expect.any(Date),
			legalAcceptances:payload.legalAcceptances,
		}));
		expect(mocks.createAccount.mock.calls[0][1].passwordHash).not.toBe(payload.password);
		expect(response.headers.get('set-cookie')).toBeNull();
		expect(mocks.verifyTurnstileToken).toHaveBeenCalledWith({
			token:payload.turnstileToken,remoteIp:'192.0.2.5',hostname:new URL(process.env.NEXT_PUBLIC_APP_URL||process.env.NEXTAUTH_URL||'https://aurevia-exchange-6hfi.onrender.com').hostname,
		});
		expect(mocks.rateLimit).toHaveBeenCalledWith('register:192.0.2.5',30,600_000);
		expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function),{
			isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted,
			maxWait:5_000,
			timeout:15_000,
		});
		expect(mocks.waitlistUpdateMany).toHaveBeenCalledWith(expect.objectContaining({where:{email:payload.email,userId:null}}));
		expect(mocks.createNotification).toHaveBeenCalledOnce();
		expect(mocks.notifyActiveAdmins).toHaveBeenCalledOnce();
	});

	it('normalizes signup email by trimming and lowercasing before persistence',async()=>{
		const response=await POST(request({...payload,email:'  NEW-USER@EXAMPLE.INVALID  '}));

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({created:true,email:'new-user@example.invalid'});
		expect(mocks.createAccount).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({email:'new-user@example.invalid'}));
	});

	it('preserves international names exactly as entered and accepts Nigerian E.164 numbers',async()=>{
		const name='  José Núñez-Sørensen 李 O’Connor  ';
		const response=await POST(request({...payload,name,country:'Nigeria',countryCode:'NG',address:{...payload.address,countryCode:'NG'},phone:'+2348031234567'}));

		expect(response.status).toBe(201);
		expect(mocks.createAccount).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
			name:'José Núñez-Sørensen 李 O’Connor',
			country:'Nigeria',
			phone:'+2348031234567',
		}));
	});

	it('returns a field-specific error for blank names',async()=>{
		const response=await POST(request({...payload,name:'   '}));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({error:'Enter your first and last name using no more than 120 characters.'});
		expect(mocks.createAccount).not.toHaveBeenCalled();
	});

	it('requires the exact current legal document versions at registration',async()=>{
		mocks.getCurrentLegalDocuments.mockResolvedValueOnce([
			...payload.legalAcceptances.map(document=>({...document,title:document.documentKey,href:'/legal-centre',requiresReacceptance:true,content:null})),
			{documentKey:'TRADING_AGREEMENT',version:'v2',title:'Trading Agreement',href:'/legal-centre',requiresReacceptance:true,content:null},
		]);
		const response=await POST(request(payload));
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({code:'LEGAL_DOCUMENTS_CHANGED'});
		expect(mocks.createAccount).not.toHaveBeenCalled();
	});

	it('still applies a shared IP limit when the trusted proxy address is unavailable',async()=>{
		mocks.trustedProxyClientIp.mockReturnValue(null);

		const response=await POST(request());

		expect(response.status).toBe(201);
		expect(mocks.rateLimit).toHaveBeenCalledWith('register:unknown',30,600_000);
	});

	it('rejects a filled honeypot without touching account data',async()=>{
		const response=await POST(request({...payload,website:'bot-filled-this'}));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({error:'Invalid registration request.'});
		expect(mocks.userFindFirst).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.createAccount).not.toHaveBeenCalled();
		expect(mocks.rateLimit).not.toHaveBeenCalled();
	});

	it('accepts optional gender, middle name, and phone fields as empty',async()=>{
		const response=await POST(request({
			...payload,gender:undefined,phone:'',name:'A User',
			firstName:'A',middleName:'',lastName:'User',
		}));

		expect(response.status).toBe(201);
		expect(mocks.createAccount).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
			name:'A User',middleName:null,phone:null,
		}));
	});

	it('rejects a failed Turnstile verification before account lookup or creation',async()=>{
		mocks.verifyTurnstileToken.mockRejectedValue(new Error('TURNSTILE_TOKEN_INVALID'));
		const response=await POST(request());

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({error:'Complete the security check and try again.'});
		expect(mocks.userFindFirst).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it('requires a Turnstile token before account creation',async()=>{
		const {turnstileToken:_,...withoutToken}=payload;
		const response=await POST(request(withoutToken));

		expect(response.status).toBe(400);
		expect(mocks.verifyTurnstileToken).not.toHaveBeenCalled();
		expect(mocks.createAccount).not.toHaveBeenCalled();
	});

	it('treats a case-variant retry with the correct password as sign-in',async()=>{
		const passwordHash=await bcrypt.hash(payload.password,4);
		mocks.userFindFirst.mockResolvedValue({
			email:payload.email,
			passwordHash,
			status:'ACTIVE',
		});
		const response=await POST(request({...payload,email:'  NEW-USER@EXAMPLE.INVALID  '}));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({created:false,accountMatched:true,email:payload.email});
		expect(response.headers.get('set-cookie')).toBeNull();
		expect(mocks.userFindFirst).toHaveBeenCalledWith({
			where:{email:{equals:payload.email,mode:'insensitive'}},
			select:{email:true,passwordHash:true,status:true},
		});
		expect(mocks.createAccount).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it('does not reveal an existing email when the supplied password is wrong',async()=>{
		mocks.userFindFirst.mockResolvedValue({
			email:payload.email,
			passwordHash:await bcrypt.hash('AnotherPassword2',4),
			status:'ACTIVE',
		});
		const response=await POST(request());
		const body=await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({code:'ACCOUNT_ACCESS_REQUIRED'});
		expect(body.error).not.toContain('already uses this email');
		expect(JSON.stringify(body)).not.toContain(payload.email);
		expect(mocks.createAccount).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it('recovers a matching account after an email unique-constraint race',async()=>{
		const passwordHash=await bcrypt.hash(payload.password,4);
		mocks.userFindFirst
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({email:payload.email,passwordHash,status:'ACTIVE'});
		mocks.transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Duplicate email',{
			code:'P2002',clientVersion:'test',meta:{target:['email']},
		}));

		const response=await POST(request());

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({created:false,accountMatched:true,email:payload.email});
	});

	it('does not map unrelated unique constraints to the duplicate-email response',async()=>{
		mocks.transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Duplicate phone',{
			code:'P2002',clientVersion:'test',meta:{target:['phone']},
		}));
		const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);

		const requestId='e75c6069-6dc9-4de5-8a58-e8257d8f8e03';
		const response=await POST(request(payload,requestId));
		const logged=JSON.stringify(error.mock.calls);

		expect(response.status).toBe(500);
		expect(await response.json()).not.toMatchObject({code:'ACCOUNT_ACCESS_REQUIRED'});
		expect(logged).toContain(requestId);
		expect(logged).toContain('P2002');
		expect(logged).toContain('phone');
		expect(logged).toContain('errorStack');
		error.mockRestore();
	});

	it('logs a sanitized server-side cause for unexpected signup failures',async()=>{
		const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);
		const info=vi.spyOn(console,'info').mockImplementation(()=>undefined);
		mocks.transaction.mockRejectedValue(new Error(`Write failed for ${payload.email} using ${payload.password}`));

		const requestId='e75c6069-6dc9-4de5-8a58-e8257d8f8e03';
		const response=await POST(request(payload,requestId));
		const logged=JSON.stringify(error.mock.calls);
		const timing=JSON.stringify(info.mock.calls);

		expect(response.status).toBe(500);
		expect(logged).toContain('Write failed');
		expect(logged).toContain(requestId);
		expect(logged).toContain('errorStack');
		expect(logged).not.toContain(payload.email);
		expect(logged).not.toContain(payload.password);
		expect(timing).toContain(requestId);
		expect(timing).toContain('transactionDurationMs');
		expect(timing).toContain('"transactionOutcome":"failed"');
		error.mockRestore();
		info.mockRestore();
	});

	it('keeps post-commit notification failures from turning a committed signup into an API failure',async()=>{
		const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);
		mocks.createNotification.mockRejectedValueOnce(new Error('notification insert unavailable'));

		const response=await POST(request());
		const logged=JSON.stringify(error.mock.calls);

		expect(response.status).toBe(201);
		expect(logged).toContain('Post-registration effect failed');
		expect(logged).toContain('welcome notification');
		error.mockRestore();
	});

	it('maps a phone number collision to a safe user-facing error',async()=>{
		mocks.createAccount.mockRejectedValue(new Error('REGISTRATION_PHONE_ALREADY_IN_USE'));
		const response=await POST(request());

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({code:'PHONE_ALREADY_IN_USE'});
	});

	it('rejects invalid international phone numbers before persisting data',async()=>{
		const response=await POST(request({...payload,phone:'2025550123'}));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({error:'Enter a valid phone number in international format.'});
		expect(mocks.createAccount).not.toHaveBeenCalled();
	});

	it('returns Retry-After when a registration quota is exhausted',async()=>{
		mocks.rateLimit.mockImplementationOnce(()=>{throw new mocks.RateLimitError(73)});
		const response=await POST(request());

		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('73');
		expect(mocks.createAccount).not.toHaveBeenCalled();
	});
});
