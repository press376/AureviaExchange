import {randomUUID} from 'node:crypto';
import {getServerConfiguration} from '@/lib/config/env';

const SITEVERIFY_URL='https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstileToken(input:{token:string;remoteIp?:string|null;hostname:string}){
	const {secretKey}=getServerConfiguration().turnstile;
	if(!secretKey)throw new Error('TURNSTILE_CONFIGURATION_REQUIRED');
	const body=new URLSearchParams({secret:secretKey,response:input.token,idempotency_key:randomUUID()});
	if(input.remoteIp)body.set('remoteip',input.remoteIp);
	let response:Response;
	try{
		response=await fetch(SITEVERIFY_URL,{
			method:'POST',
			headers:{'content-type':'application/x-www-form-urlencoded'},
			body,
			signal:AbortSignal.timeout(5_000),
			redirect:'error',
		});
	}catch{throw new Error('TURNSTILE_PROVIDER_UNAVAILABLE')}
	if(!response.ok)throw new Error('TURNSTILE_PROVIDER_UNAVAILABLE');
	const result:unknown=await response.json().catch(()=>null);
	if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('TURNSTILE_PROVIDER_UNAVAILABLE');
	const verification=result as {success?:unknown;action?:unknown;hostname?:unknown};
	if(verification.success!==true
		||verification.action!=='register'
		||typeof verification.hostname!=='string'
		||verification.hostname.toLowerCase()!==input.hostname.toLowerCase()){
		throw new Error('TURNSTILE_TOKEN_INVALID');
	}
}
