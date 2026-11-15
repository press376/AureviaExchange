import {NextResponse} from 'next/server';
import {getCurrentLegalDocuments} from '@/lib/legal-acceptance';

export async function GET(){
	try{
		const documents=await getCurrentLegalDocuments();
		return NextResponse.json({documents:documents.map(({documentKey,title,href,version})=>({documentKey,title,href,version}))},{headers:{'Cache-Control':'public, max-age=60'}});
	}catch(error){
		console.error('Current legal document versions could not be loaded.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Current legal documents are temporarily unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});
	}
}
