import {NextResponse} from 'next/server';
import {processKycRetentionBatch} from '@/lib/kyc-retention';
import {safeSecretEquals} from '@/lib/push-notifications';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;

export async function GET(request:Request){
	if(!safeSecretEquals(request.headers.get('authorization')?.replace(/^Bearer\s+/i,''),process.env.CRON_SECRET)){
		return NextResponse.json({error:'Unauthorized'},{status:401,headers:{'Cache-Control':'no-store'}});
	}
	try{
		const result=await processKycRetentionBatch(3);
		return NextResponse.json({ok:true,result},{headers:{'Cache-Control':'no-store'}});
	}catch(error){
		console.error('KYC evidence retention worker failed.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'KYC evidence retention is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});
	}
}
