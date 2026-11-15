import {AccountMode,GenderSelection,Prisma} from '@prisma/client';
import {generateAureviaExchangeId} from '@/lib/aurevia-exchange-id';
import {initializePaperAccount} from '@/lib/ledger';
import {getCurrentLegalDocuments,recordLegalAcceptances} from '@/lib/legal-acceptance';
import {deliverPublishedNoticesToUser} from '@/lib/managed-notice-delivery';
import type {LegalDocumentKey} from '@/lib/registration-legal';

export type ImmediateRegistrationInput={
	email:string;
	passwordHash:string;
	name:string;
	firstName:string;
	middleName:string|null;
	lastName:string;
	nationality:string|null;
	preferredLanguage:string|null;
	country:string;
	gender?:GenderSelection;
	phone:string|null;
	alternativePhone:string|null;
	preferredContactMethod:string|null;
	dateOfBirth:Date;
	accountMode:AccountMode;
	address:{
		line1:string;
		line2:string|null;
		apartment:string|null;
		buildingName:string|null;
		city:string;
		district:string|null;
		stateProvince:string|null;
		postalCode:string|null;
		country:string;
		type:string|null;
	};
	termsAcceptedAt:Date;
	legalAcceptances:Array<{documentKey:LegalDocumentKey;version:string}>;
};

export async function createImmediateRegistration(
	tx:Prisma.TransactionClient,
	input:ImmediateRegistrationInput,
	now=new Date(),
){
	const currentLegalDocuments=await getCurrentLegalDocuments(now,tx);
	const acceptedVersions=new Map(input.legalAcceptances.map(document=>[document.documentKey,document.version]));
	if(acceptedVersions.size!==input.legalAcceptances.length
		||currentLegalDocuments.length!==acceptedVersions.size
		||currentLegalDocuments.some(document=>acceptedVersions.get(document.documentKey)!==document.version)){
		throw new Error('LEGAL_DOCUMENTS_CHANGED');
	}
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.email})::bigint)`;
	if(input.phone)await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.phone})::bigint)`;

	if(await tx.user.findFirst({where:{email:{equals:input.email,mode:'insensitive'}},select:{id:true}}))throw new Error('REGISTRATION_EMAIL_ALREADY_EXISTS');
	if(input.phone&&await tx.user.findFirst({where:{phone:input.phone},select:{id:true}}))throw new Error('REGISTRATION_PHONE_ALREADY_IN_USE');

	let userCreated=false;
	for(let collisionAttempt=0;collisionAttempt<5&&!userCreated;collisionAttempt++){
		const created=await tx.user.createMany({
			data:[{
				aureviaExchangeId:generateAureviaExchangeId(now),
				email:input.email,
				passwordHash:input.passwordHash,
				name:input.name,
				firstName:input.firstName,
				middleName:input.middleName,
				lastName:input.lastName,
				nationality:input.nationality,
				preferredLanguage:input.preferredLanguage,
				country:input.country,
				gender:input.gender,
				phone:input.phone,
				alternativePhone:input.alternativePhone,
				preferredContactMethod:input.preferredContactMethod,
				phoneVerified:false,
				phoneVerifiedAt:null,
				twoFactorEnabled:false,
				role:'USER',
				accountMode:input.accountMode,
				termsAcceptedAt:input.termsAcceptedAt,
				status:'ACTIVE',
				createdAt:now,
				updatedAt:now,
			}],
			skipDuplicates:true,
		});
		if(created.count===1){
			userCreated=true;
			break;
		}
		if(await tx.user.findFirst({where:{email:{equals:input.email,mode:'insensitive'}},select:{id:true}}))throw new Error('REGISTRATION_EMAIL_ALREADY_EXISTS');
		if(input.phone&&await tx.user.findFirst({where:{phone:input.phone},select:{id:true}}))throw new Error('REGISTRATION_PHONE_ALREADY_IN_USE');
	}
	if(!userCreated)throw new Error('AUREVIA_ID_COLLISION_RETRIES_EXHAUSTED');

	const user=await tx.user.findUniqueOrThrow({where:{email:input.email}});
	await recordLegalAcceptances(tx,user.id,input.legalAcceptances,input.termsAcceptedAt,'registration');
	await deliverPublishedNoticesToUser(tx,user.id,now);
	await tx.kycProfile.create({
		data:{
			userId:user.id,
			dob:input.dateOfBirth,
			address:[input.address.line1,input.address.line2,input.address.apartment,input.address.buildingName,input.address.city,input.address.district,input.address.stateProvince,input.address.postalCode,input.address.country].filter(Boolean).join(', '),
			addressLine1:input.address.line1,
			addressLine2:input.address.line2,
			apartment:input.address.apartment,
			buildingName:input.address.buildingName,
			city:input.address.city,
			district:input.address.district,
			stateProvince:input.address.stateProvince,
			postalCode:input.address.postalCode,
			addressCountry:input.address.country,
			addressType:input.address.type,
		},
	});
	await initializePaperAccount(tx,user.id,AccountMode.DEMO);
	await initializePaperAccount(tx,user.id,AccountMode.REAL);
	return user;
}
