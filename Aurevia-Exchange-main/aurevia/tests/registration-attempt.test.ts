import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Prisma} from '@prisma/client';

const mocks=vi.hoisted(()=>({
	advisoryLock:vi.fn(),
	userFindFirst:vi.fn(),
	userFindUnique:vi.fn(),
	userCreateMany:vi.fn(),
	userFindUniqueOrThrow:vi.fn(),
	waitlistUpdateMany:vi.fn(),
	termsAcceptanceCreateMany:vi.fn(),
	legalAcceptanceCreateMany:vi.fn(),
	managedNoticeFindFirst:vi.fn(),
	managedNoticeFindMany:vi.fn(),
	notificationCreateMany:vi.fn(),
	kycCreate:vi.fn(),
	initializePaperAccount:vi.fn(),
}));

vi.mock('@/lib/ledger',()=>({initializePaperAccount:mocks.initializePaperAccount}));

import {createImmediateRegistration} from '@/lib/registration-attempt';

const legalAcceptances=[
	{documentKey:'TERMS_AND_CONDITIONS',version:'2026-10-27'},
	{documentKey:'PRIVACY_POLICY',version:'privacy'},
	{documentKey:'RISK_DISCLOSURE',version:'2026-10-27'},
	{documentKey:'AML_KYC_POLICY',version:'2026-11-15-v1'},
	{documentKey:'DEPOSIT_WITHDRAWAL_POLICY',version:'2026-11-15-v1'},
	{documentKey:'PLATFORM_USAGE_POLICY',version:'2026-11-15-v1'},
] as const;

describe('immediate registration account creation',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.userFindFirst.mockResolvedValue(null);
		mocks.userFindUnique.mockResolvedValue(null);
		mocks.userCreateMany.mockResolvedValue({count:1});
		mocks.userFindUniqueOrThrow.mockResolvedValue({id:'new-user',accountMode:'DEMO'});
		mocks.waitlistUpdateMany.mockResolvedValue({count:0});
		mocks.termsAcceptanceCreateMany.mockResolvedValue({count:1});
		mocks.legalAcceptanceCreateMany.mockResolvedValue({count:6});
		mocks.managedNoticeFindFirst.mockResolvedValue(null);
		mocks.managedNoticeFindMany.mockResolvedValue([]);
		mocks.notificationCreateMany.mockResolvedValue({count:0});
		mocks.kycCreate.mockResolvedValue({});
		mocks.initializePaperAccount.mockResolvedValue(undefined);
	});

	it('creates active accounts without signup email or phone verification',async()=>{
		const tx={
			$executeRaw:mocks.advisoryLock,
			user:{findFirst:mocks.userFindFirst,createMany:mocks.userCreateMany,findUnique:mocks.userFindUnique,findUniqueOrThrow:mocks.userFindUniqueOrThrow},
			waitlistEntry:{updateMany:mocks.waitlistUpdateMany},
			termsAcceptance:{createMany:mocks.termsAcceptanceCreateMany},
			registrationLegalAcceptance:{createMany:mocks.legalAcceptanceCreateMany},
			managedNotice:{findFirst:mocks.managedNoticeFindFirst,findMany:mocks.managedNoticeFindMany},
			notification:{createMany:mocks.notificationCreateMany},
			kycProfile:{create:mocks.kycCreate},
		} as unknown as Prisma.TransactionClient;

		const termsAcceptedAt=new Date('2026-11-10T12:00:00.000Z');
		await createImmediateRegistration(tx,{
			email:'person@example.invalid',
			passwordHash:'bcrypt-hash',
			name:'Person Example',
			firstName:'Person',
			middleName:null,
			lastName:'Example',
			nationality:null,
			preferredLanguage:null,
			country:'Nigeria',
			gender:'FEMALE',
			phone:'+2348031234567',
			alternativePhone:null,
			preferredContactMethod:null,
			dateOfBirth:new Date('1990-01-01T00:00:00.000Z'),
			accountMode:'DEMO',
			address:{
				line1:'1 Example Road',line2:null,apartment:null,buildingName:null,city:'Lagos',
				district:null,stateProvince:null,postalCode:null,country:'Nigeria',type:null,
			},
			termsAcceptedAt,
			legalAcceptances:[...legalAcceptances],
		});

		expect(mocks.userCreateMany).toHaveBeenCalledWith(expect.objectContaining({
			data:[expect.objectContaining({
				phone:'+2348031234567',
				gender:'FEMALE',
				phoneVerified:false,
				phoneVerifiedAt:null,
				twoFactorEnabled:false,
				status:'ACTIVE',
			})],
			skipDuplicates:true,
		}));
		expect(mocks.termsAcceptanceCreateMany).toHaveBeenCalledWith({data:[{
			userId:'new-user',
			version:'2026-10-27',
			acceptedAt:termsAcceptedAt,
		}],skipDuplicates:true});
		expect(mocks.legalAcceptanceCreateMany).toHaveBeenCalledWith(expect.objectContaining({data:expect.arrayContaining([
			expect.objectContaining({userId:'new-user',documentKey:'TERMS_AND_CONDITIONS',acceptedAt:termsAcceptedAt}),
			expect.objectContaining({userId:'new-user',documentKey:'PLATFORM_USAGE_POLICY',acceptedAt:termsAcceptedAt}),
		]),skipDuplicates:true}));
		expect(mocks.initializePaperAccount).toHaveBeenCalledTimes(2);
	});

	it('records the currently published mandatory terms version for new accounts',async()=>{
		mocks.managedNoticeFindMany.mockResolvedValue([{
			type:'TERMS',title:'Terms',content:'Updated terms',version:'2026-11-10-v2',
			visibility:'MANDATORY_ACCEPTANCE',requiresReacceptance:true,publishedAt:new Date('2026-11-10T00:00:00.000Z'),
		}]);
		const tx={
			$executeRaw:mocks.advisoryLock,
			user:{findFirst:mocks.userFindFirst,createMany:mocks.userCreateMany,findUnique:mocks.userFindUnique,findUniqueOrThrow:mocks.userFindUniqueOrThrow},
			waitlistEntry:{updateMany:mocks.waitlistUpdateMany},
			termsAcceptance:{createMany:mocks.termsAcceptanceCreateMany},
			registrationLegalAcceptance:{createMany:mocks.legalAcceptanceCreateMany},
			managedNotice:{findFirst:mocks.managedNoticeFindFirst,findMany:mocks.managedNoticeFindMany},
			notification:{createMany:mocks.notificationCreateMany},
			kycProfile:{create:mocks.kycCreate},
		} as unknown as Prisma.TransactionClient;
		await createImmediateRegistration(tx,{
			email:'new-person@example.invalid',passwordHash:'bcrypt-hash',name:'New Person',country:'Nigeria',
			firstName:'New',middleName:null,lastName:'Person',nationality:null,preferredLanguage:null,
			gender:'FEMALE',phone:null,alternativePhone:null,preferredContactMethod:null,dateOfBirth:new Date('1990-01-01T00:00:00.000Z'),accountMode:'DEMO',
			address:{
				line1:'1 Example Road',line2:null,apartment:null,buildingName:null,city:'Lagos',
				district:null,stateProvince:null,postalCode:null,country:'Nigeria',type:null,
			},
			termsAcceptedAt:new Date('2026-11-10T12:00:00.000Z'),
			legalAcceptances:legalAcceptances.map(document=>document.documentKey==='TERMS_AND_CONDITIONS'
				?{...document,version:'2026-11-10-v2'}:document),
		});
		expect(mocks.termsAcceptanceCreateMany).toHaveBeenCalledWith({data:[expect.objectContaining({version:'2026-11-10-v2'})],skipDuplicates:true});
	});
});
