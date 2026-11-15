import {ManagedNoticeStatus,ManagedNoticeType,NoticeVisibility,Prisma} from '@prisma/client';
import {db} from '@/lib/db';
import {CURRENT_TERMS_VERSION} from '@/lib/policy-consent';
import {REGISTRATION_LEGAL_DOCUMENTS,type LegalDocumentKey} from '@/lib/registration-legal';

const managedTypeByKey:Partial<Record<LegalDocumentKey,ManagedNoticeType>>={
	TERMS_AND_CONDITIONS:ManagedNoticeType.TERMS,
	PRIVACY_POLICY:ManagedNoticeType.PRIVACY,
	RISK_DISCLOSURE:ManagedNoticeType.RISK_DISCLOSURE,
	AML_KYC_POLICY:ManagedNoticeType.AML_KYC,
	DEPOSIT_WITHDRAWAL_POLICY:ManagedNoticeType.DEPOSIT_WITHDRAWAL,
	PLATFORM_USAGE_POLICY:ManagedNoticeType.PLATFORM_USAGE,
	COOKIE_POLICY:ManagedNoticeType.COOKIE_POLICY,
	TRADING_AGREEMENT:ManagedNoticeType.TRADING_AGREEMENT,
};

const optionalPolicyDocuments=[
	{key:'COOKIE_POLICY',title:'Cookie Policy',href:'/legal-centre?type=COOKIE_POLICY'},
	{key:'TRADING_AGREEMENT',title:'Trading Agreement',href:'/legal-centre?type=TRADING_AGREEMENT'},
] as const;

export type CurrentLegalDocument={
	documentKey:LegalDocumentKey;
	title:string;
	href:string;
	version:string;
	requiresReacceptance:boolean;
	content:string|null;
};

type LegalAcceptanceClient=Pick<typeof db,'managedNotice'|'registrationLegalAcceptance'|'termsAcceptance'>;

export async function getCurrentLegalDocuments(now=new Date(),client:LegalAcceptanceClient=db){
	const managedNotices=await client.managedNotice.findMany({
		where:{
			status:ManagedNoticeStatus.PUBLISHED,
			enabled:true,
			type:{not:ManagedNoticeType.ANNOUNCEMENT},
			AND:[
				{OR:[
					{type:ManagedNoticeType.TERMS,visibility:NoticeVisibility.MANDATORY_ACCEPTANCE},
					{type:ManagedNoticeType.PRIVACY,visibility:{in:[NoticeVisibility.USERS,NoticeVisibility.MANDATORY_ACCEPTANCE]}},
					{type:{in:[
						ManagedNoticeType.RISK_DISCLOSURE,ManagedNoticeType.AML_KYC,ManagedNoticeType.DEPOSIT_WITHDRAWAL,
						ManagedNoticeType.PLATFORM_USAGE,
					]},visibility:NoticeVisibility.MANDATORY_ACCEPTANCE},
					{type:{in:[ManagedNoticeType.COOKIE_POLICY,ManagedNoticeType.TRADING_AGREEMENT]},visibility:NoticeVisibility.MANDATORY_ACCEPTANCE,requiresReacceptance:true},
				]},
				{OR:[{startsAt:null},{startsAt:{lte:now}}]},
				{OR:[{endsAt:null},{endsAt:{gt:now}}]},
			],
		},
		orderBy:[{publishedAt:'desc'},{createdAt:'desc'}],
		select:{type:true,title:true,content:true,version:true,visibility:true,requiresReacceptance:true,publishedAt:true},
	});
	const newestByType=new Map<ManagedNoticeType,typeof managedNotices[number]>();
	for(const notice of managedNotices)if(!newestByType.has(notice.type))newestByType.set(notice.type,notice);
	const currentTerms=newestByType.get(ManagedNoticeType.TERMS);
	const currentPrivacy=newestByType.get(ManagedNoticeType.PRIVACY);
	const baseDocuments=REGISTRATION_LEGAL_DOCUMENTS.map(document=>{
		const notice=newestByType.get(managedTypeByKey[document.key]!);
		const version=document.key==='TERMS_AND_CONDITIONS'
			?(currentTerms?.version||CURRENT_TERMS_VERSION)
			:document.key==='PRIVACY_POLICY'
				?(currentPrivacy?.version||document.version)
				:(notice?.version||document.version);
		return {
			documentKey:document.key,
			title:document.title,
			href:document.href,
			version,
			requiresReacceptance:notice?.requiresReacceptance??true,
			content:notice?.version===version?notice.content:null,
		};
	});
	const baseKeys=new Set<string>(baseDocuments.map(document=>document.documentKey));
	const optionalDocuments=optionalPolicyDocuments.flatMap(document=>{
		const notice=newestByType.get(managedTypeByKey[document.key]!);
		if(!notice||notice.visibility!==NoticeVisibility.MANDATORY_ACCEPTANCE||!notice.requiresReacceptance||!notice.version)return [];
		return [{
			documentKey:document.key,
			title:notice.title||document.title,
			href:document.href,
			version:notice.version,
			requiresReacceptance:true,
			content:notice.content,
		}];
	}).filter(document=>!baseKeys.has(document.documentKey));
	const otherRequiredDocuments=managedNotices.flatMap(notice=>{
		const documentKey=Object.entries(managedTypeByKey).find(([,type])=>type===notice.type)?.[0] as LegalDocumentKey|undefined;
		if(!documentKey||baseKeys.has(documentKey)||optionalPolicyDocuments.some(document=>document.key===documentKey)
			||notice.visibility!==NoticeVisibility.MANDATORY_ACCEPTANCE||!notice.requiresReacceptance||!notice.version)return [];
		return [{
			documentKey,
			title:notice.title,
			href:`/legal-centre?type=${encodeURIComponent(documentKey)}`,
			version:notice.version,
			requiresReacceptance:true,
			content:notice.content,
		}];
	});
	return [...baseDocuments,...optionalDocuments,...otherRequiredDocuments];
}

export async function getLegalAcceptanceStatus(userId:string,now=new Date(),client:LegalAcceptanceClient=db){
	const documents=await getCurrentLegalDocuments(now,client);
	const [acceptances,legacyTerms]=await Promise.all([
		client.registrationLegalAcceptance.findMany({
			where:{userId,documentKey:{in:documents.map(document=>document.documentKey)}},
			select:{documentKey:true,version:true,acceptedAt:true},
		}),
		client.termsAcceptance.findMany({
			where:{userId},
			select:{version:true,acceptedAt:true},
		}),
	]);
	const acceptedByKey=new Map(acceptances.map(item=>[`${item.documentKey}:${item.version}`,item.acceptedAt]));
	const acceptedByDocument=new Map<string,Date>();
	for(const acceptance of acceptances){
		const previous=acceptedByDocument.get(acceptance.documentKey);
		if(!previous||acceptance.acceptedAt>previous)acceptedByDocument.set(acceptance.documentKey,acceptance.acceptedAt);
	}
	const legacyTermsByVersion=new Map(legacyTerms.map(item=>[item.version,item.acceptedAt]));
	const latestLegacyTermsAt=legacyTerms.reduce<Date|null>((latest,item)=>!latest||item.acceptedAt>latest?item.acceptedAt:latest,null);
	return documents.map(document=>{
		const acceptedAt=acceptedByKey.get(`${document.documentKey}:${document.version}`)
			||(!document.requiresReacceptance?acceptedByDocument.get(document.documentKey):undefined)
			||(document.documentKey==='TERMS_AND_CONDITIONS'
				?(legacyTermsByVersion.get(document.version)||(!document.requiresReacceptance?latestLegacyTermsAt:undefined))
				:undefined)
			||null;
		return {...document,accepted:Boolean(acceptedAt),acceptedAt};
	});
}

export async function recordLegalAcceptances(tx:Prisma.TransactionClient,userId:string,documents:Pick<CurrentLegalDocument,'documentKey'|'version'>[],acceptedAt=new Date(),channel:'registration'|'policy-consent'){
	if(!documents.length)return;
	await tx.registrationLegalAcceptance.createMany({
		data:documents.map(document=>({
			userId,
			documentKey:document.documentKey,
			version:document.version,
			acceptedAt,
			auditMetadata:{channel,documentKey:document.documentKey,version:document.version},
		})),
		skipDuplicates:true,
	});
	const terms=documents.find(document=>document.documentKey==='TERMS_AND_CONDITIONS');
	if(terms)await tx.termsAcceptance.createMany({
		data:[{userId,version:terms.version,acceptedAt}],
		skipDuplicates:true,
	});
}
