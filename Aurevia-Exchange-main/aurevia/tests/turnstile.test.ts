import {afterEach,describe,expect,it,vi} from 'vitest';
import {verifyTurnstileToken} from '../lib/turnstile';

afterEach(()=>{
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe('Cloudflare Turnstile verification',()=>{
	it('submits the token and accepts only a successful registration challenge for the expected host',async()=>{
		vi.stubEnv('TURNSTILE_SECRET_KEY','server-only-test-secret');
		const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({
			success:true,action:'register',hostname:'aurevia.test',
		}),{status:200,headers:{'content-type':'application/json'}}));
		vi.stubGlobal('fetch',fetchMock);

		await expect(verifyTurnstileToken({token:'single-use-test-token',remoteIp:'192.0.2.1',hostname:'aurevia.test'})).resolves.toBeUndefined();
		const [url,options]=fetchMock.mock.calls[0] as [string,RequestInit];
		expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
		expect(new URLSearchParams(options.body as URLSearchParams).get('secret')).toBe('server-only-test-secret');
		expect(new URLSearchParams(options.body as URLSearchParams).get('response')).toBe('single-use-test-token');
		expect(new URLSearchParams(options.body as URLSearchParams).get('remoteip')).toBe('192.0.2.1');
	});

	it('rejects missing configuration, expired or reused tokens, and mismatched action or hostname',async()=>{
		const fetchMock=vi.fn();
		vi.stubGlobal('fetch',fetchMock);
		await expect(verifyTurnstileToken({token:'token',hostname:'aurevia.test'})).rejects.toThrow('TURNSTILE_CONFIGURATION_REQUIRED');
		expect(fetchMock).not.toHaveBeenCalled();

		vi.stubEnv('TURNSTILE_SECRET_KEY','server-only-test-secret');
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({success:false,'error-codes':['timeout-or-duplicate']}),{status:200}));
		await expect(verifyTurnstileToken({token:'expired-or-reused',hostname:'aurevia.test'})).rejects.toThrow('TURNSTILE_TOKEN_INVALID');
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({success:true,action:'other',hostname:'aurevia.test'}),{status:200}));
		await expect(verifyTurnstileToken({token:'wrong-action',hostname:'aurevia.test'})).rejects.toThrow('TURNSTILE_TOKEN_INVALID');
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({success:true,action:'register',hostname:'attacker.test'}),{status:200}));
		await expect(verifyTurnstileToken({token:'wrong-host',hostname:'aurevia.test'})).rejects.toThrow('TURNSTILE_TOKEN_INVALID');
	});

	it('fails closed when Siteverify is unavailable or malformed',async()=>{
		vi.stubEnv('TURNSTILE_SECRET_KEY','server-only-test-secret');
		const fetchMock=vi.fn().mockRejectedValue(new Error('network unavailable'));
		vi.stubGlobal('fetch',fetchMock);
		await expect(verifyTurnstileToken({token:'token',hostname:'aurevia.test'})).rejects.toThrow('TURNSTILE_PROVIDER_UNAVAILABLE');

		fetchMock.mockResolvedValue(new Response('not-json',{status:200}));
		await expect(verifyTurnstileToken({token:'token',hostname:'aurevia.test'})).rejects.toThrow('TURNSTILE_PROVIDER_UNAVAILABLE');
	});
});
