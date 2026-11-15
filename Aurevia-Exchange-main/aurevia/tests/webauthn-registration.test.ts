import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	generateRegistrationOptions:vi.fn(),
	storeChallenge:vi.fn(),
	requireUser:vi.fn(),
	consumeRecentReauthentication:vi.fn(),
	userFindUnique:vi.fn(),
	credentialCount:vi.fn(),
}));

vi.mock('@simplewebauthn/server',()=>({generateRegistrationOptions:mocks.generateRegistrationOptions}));
vi.mock('@/lib/webauthn',()=>({
	storeChallenge:mocks.storeChallenge,
	WEBAUTHN_RP_ID:'aurevia.test',
	WEBAUTHN_RP_NAME:'Aurevia Exchange',
}));
vi.mock('@/lib/auth',()=>({requireUser:mocks.requireUser}));
vi.mock('@/lib/security-auth',()=>({consumeRecentReauthentication:mocks.consumeRecentReauthentication}));
vi.mock('@/lib/db',()=>({db:{
	user:{findUnique:mocks.userFindUnique},
	webAuthnCredential:{count:mocks.credentialCount},
}}));

import {POST} from '@/app/api/webauthn/register/start/route';

describe('passkey registration start',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.requireUser.mockResolvedValue({id:'user-1',sessionHash:'session-hash'});
		mocks.consumeRecentReauthentication.mockResolvedValue(false);
		mocks.userFindUnique.mockResolvedValue({email:'person@example.invalid',name:'Aurevia User'});
		mocks.credentialCount.mockResolvedValue(0);
		mocks.storeChallenge.mockResolvedValue('fresh-challenge');
		mocks.generateRegistrationOptions.mockResolvedValue({challenge:'generated-challenge'});
	});

	it('rejects registration unless the current session has fresh password verification',async()=>{
		const response=await POST();

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({error:'Verify your current password before adding a passkey.'});
		expect(mocks.consumeRecentReauthentication).toHaveBeenCalledWith({userId:'user-1',sessionHash:'session-hash'});
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
		expect(mocks.storeChallenge).not.toHaveBeenCalled();
	});

	it('consumes fresh verification before issuing registration options',async()=>{
		mocks.consumeRecentReauthentication.mockResolvedValue(true);

		const response=await POST();

		expect(response.status).toBe(200);
		expect(mocks.userFindUnique).toHaveBeenCalledWith({
			where:{id:'user-1'},
			select:{email:true,name:true},
		});
		expect(mocks.storeChallenge).toHaveBeenCalledWith({userId:'user-1',type:'register'});
		expect(mocks.generateRegistrationOptions).toHaveBeenCalled();
		expect(await response.json()).toMatchObject({challenge:'fresh-challenge'});
	});
});
