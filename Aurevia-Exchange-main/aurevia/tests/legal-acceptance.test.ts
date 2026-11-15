import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Prisma} from '@prisma/client';
import {getCurrentLegalDocuments,getLegalAcceptanceStatus,recordLegalAcceptances} from '@/lib/legal-acceptance';

const mocks=vi.hoisted(()=>({
	managedNoticeFindMany:vi.fn(),
	legalAcceptanceFindMany:vi.fn(),
	termsAcceptanceFindMany:vi.fn(),
	legalAcceptanceCreateMany:vi.fn(),
	termsAcceptanceCreateMany:vi.fn(),
}));

vi.mock('@/lib/db',()=>({db:{
	managedNotice:{findMany:mocks.managedNoticeFindMany},
	registrationLegalAcceptance:{findMany:mocks.legalAcceptanceFindMany,createMany:mocks.legalAcceptanceCreateMany},
	termsAcceptance:{findMany:mocks.termsAcceptanceFindMany,createMany:mocks.termsAcceptanceCreateMany},
}}));

const managed=(overrides:Record<string,unknown>={})=>({
	type:'TERMS',title:'Current terms',content:'policy content',version:'terms-v2',
	visibility:'MANDATORY_ACCEPTANCE',requiresReacceptance:true,publishedAt:new Date('2026-11-10T00:00:00.000Z'),
	...overrides,
});

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.managedNoticeFindMany.mockResolvedValue([]);
	mocks.legalAcceptanceFindMany.mockResolvedValue([]);
	mocks.termsAcceptanceFindMany.mockResolvedValue([]);
	mocks.legalAcceptanceCreateMany.mockResolvedValue({count:1});
	mocks.termsAcceptanceCreateMany.mockResolvedValue({count:1});
});

describe('persistent legal acceptance',()=>{
	it('uses published mandatory versions and includes newly required policy documents',async()=>{
		mocks.managedNoticeFindMany.mockResolvedValue([
			managed(),
			managed({type:'COOKIE_POLICY',title:'Cookie policy',version:'cookie-v3'}),
			managed({type:'RISK_DISCLOSURE',title:'Risk disclosure',version:'risk-v2',requiresReacceptance:false}),
		]);
		const documents=await getCurrentLegalDocuments(new Date('2026-11-15T00:00:00.000Z'));
		expect(documents.find(document=>document.documentKey==='TERMS_AND_CONDITIONS')?.version).toBe('terms-v2');
		expect(documents.find(document=>document.documentKey==='COOKIE_POLICY')).toMatchObject({
			title:'Cookie policy',version:'cookie-v3',requiresReacceptance:true,
		});
		expect(documents.find(document=>document.documentKey==='RISK_DISCLOSURE')).toMatchObject({
			version:'risk-v2',requiresReacceptance:false,
		});
		expect(mocks.managedNoticeFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({status:'PUBLISHED',enabled:true}),
		}));
	});

	it('requires the newly published version without rewriting the previous acceptance',async()=>{
		mocks.managedNoticeFindMany.mockResolvedValue([managed()]);
		mocks.legalAcceptanceFindMany.mockResolvedValue([{documentKey:'TERMS_AND_CONDITIONS',version:'terms-v1',acceptedAt:new Date('2026-10-01T00:00:00.000Z')}]);
		mocks.termsAcceptanceFindMany.mockResolvedValue([{version:'terms-v1',acceptedAt:new Date('2026-10-01T00:00:00.000Z')}]);
		const status=await getLegalAcceptanceStatus('user-a',new Date('2026-11-15T00:00:00.000Z'));
		expect(status.find(document=>document.documentKey==='TERMS_AND_CONDITIONS')).toMatchObject({
			version:'terms-v2',accepted:false,acceptedAt:null,
		});
		expect(mocks.legalAcceptanceFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where:expect.objectContaining({userId:'user-a'}),
		}));
	});

	it('does not reprompt for an existing acceptance when the published version does not require renewal',async()=>{
		mocks.managedNoticeFindMany.mockResolvedValue([managed({
			type:'RISK_DISCLOSURE',title:'Risk disclosure',version:'risk-v2',requiresReacceptance:false,
		})]);
		mocks.legalAcceptanceFindMany.mockResolvedValue([{
			documentKey:'RISK_DISCLOSURE',version:'risk-v1',acceptedAt:new Date('2026-10-01T00:00:00.000Z'),
		}]);
		const status=await getLegalAcceptanceStatus('user-a',new Date('2026-11-15T00:00:00.000Z'));
		expect(status.find(document=>document.documentKey==='RISK_DISCLOSURE')).toMatchObject({
			version:'risk-v2',requiresReacceptance:false,accepted:true,acceptedAt:new Date('2026-10-01T00:00:00.000Z'),
		});
	});

	it('records every accepted version idempotently and mirrors terms to legacy history',async()=>{
		const acceptedAt=new Date('2026-11-15T12:00:00.000Z');
		await recordLegalAcceptances({registrationLegalAcceptance:{createMany:mocks.legalAcceptanceCreateMany},termsAcceptance:{createMany:mocks.termsAcceptanceCreateMany}} as unknown as Prisma.TransactionClient,
			'user-a',[
				{documentKey:'TERMS_AND_CONDITIONS',version:'terms-v2'},
				{documentKey:'PRIVACY_POLICY',version:'privacy-v1'},
			],acceptedAt,'registration');
		expect(mocks.legalAcceptanceCreateMany).toHaveBeenCalledWith({
			data:[
				expect.objectContaining({userId:'user-a',documentKey:'TERMS_AND_CONDITIONS',version:'terms-v2',acceptedAt,auditMetadata:{channel:'registration',documentKey:'TERMS_AND_CONDITIONS',version:'terms-v2'}}),
				expect.objectContaining({userId:'user-a',documentKey:'PRIVACY_POLICY',version:'privacy-v1',acceptedAt,auditMetadata:{channel:'registration',documentKey:'PRIVACY_POLICY',version:'privacy-v1'}}),
			],
			skipDuplicates:true,
		});
		expect(mocks.termsAcceptanceCreateMany).toHaveBeenCalledWith({
			data:[{userId:'user-a',version:'terms-v2',acceptedAt}],
			skipDuplicates:true,
		});
	});
});
