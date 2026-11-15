import {NextResponse} from 'next/server';
import {getServerSession} from 'next-auth';
import {ManagedNoticeStatus,ManagedNoticeType,NoticeVisibility} from '@prisma/client';
import {authOptions} from '@/lib/auth-options';
import {db} from '@/lib/db';
import {getCurrentLegalDocuments,getLegalAcceptanceStatus} from '@/lib/legal-acceptance';

export async function GET(){
	try{
		const session=await getServerSession(authOptions);
		const userId=session?.user?.id;
		const [versions,acceptances,legacyTerms]=await Promise.all([
			db.managedNotice.findMany({
				where:{
					type:{not:ManagedNoticeType.ANNOUNCEMENT},
					visibility:{in:[NoticeVisibility.USERS,NoticeVisibility.MANDATORY_ACCEPTANCE]},
					status:{in:[ManagedNoticeStatus.PUBLISHED,ManagedNoticeStatus.UNPUBLISHED,ManagedNoticeStatus.ARCHIVED]},
					publishedAt:{not:null},
				},
				select:{id:true,type:true,title:true,content:true,version:true,status:true,requiresReacceptance:true,publishedAt:true,startsAt:true,endsAt:true},
				orderBy:[{type:'asc'},{publishedAt:'desc'}],
				take:500,
			}),
			userId?db.registrationLegalAcceptance.findMany({
				where:{userId},
				select:{documentKey:true,version:true,acceptedAt:true,auditMetadata:true},
				orderBy:{acceptedAt:'desc'},
				take:500,
			}):Promise.resolve([]),
			userId?db.termsAcceptance.findMany({where:{userId},select:{version:true,acceptedAt:true},orderBy:{acceptedAt:'desc'},take:500}):Promise.resolve([]),
		]);
		const [currentDocuments,currentStatus]=await Promise.all([
			getCurrentLegalDocuments(),
			userId?getLegalAcceptanceStatus(userId):Promise.resolve([]),
		]);
		const currentByKey=new Map(currentStatus.map(item=>[item.documentKey,item]));
		const historicalAcceptances=[
			...acceptances.map(item=>({...item,source:'LEGAL_DOCUMENT'})),
			...legacyTerms.map(item=>({documentKey:'TERMS_AND_CONDITIONS',version:item.version,acceptedAt:item.acceptedAt,auditMetadata:{channel:'legacy-terms-acceptance'},source:'TERMS_ACCEPTANCE'})),
		];
		return NextResponse.json({
			documents:currentDocuments.map(document=>({
				documentKey:document.documentKey,title:document.title,href:document.href,version:document.version,
				accepted:currentByKey.get(document.documentKey)?.accepted??false,
				acceptedAt:currentByKey.get(document.documentKey)?.acceptedAt??null,
			})),
			versions,
			acceptances:historicalAcceptances,
		},{headers:{'Cache-Control':userId?'private, no-store':'public, max-age=60'}});
	}catch(error){
		console.error('Legal Centre content could not be loaded.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Legal Centre is temporarily unavailable.'},{status:503,headers:{'Cache-Control':'no-store'}});
	}
}
