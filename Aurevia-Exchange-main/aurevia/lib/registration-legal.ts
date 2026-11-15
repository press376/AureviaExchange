export const REGISTRATION_LEGAL_DOCUMENTS=[
	{key:'TERMS_AND_CONDITIONS',title:'Terms & Conditions',href:'/terms',version:'terms'},
	{key:'PRIVACY_POLICY',title:'Privacy Policy',href:'/privacy',version:'privacy'},
	{key:'RISK_DISCLOSURE',title:'Risk Disclosure',href:'/risk-disclosure',version:'2026-10-27'},
	{key:'AML_KYC_POLICY',title:'AML/KYC Policy',href:'/aml-kyc',version:'2026-11-15-v1'},
	{key:'DEPOSIT_WITHDRAWAL_POLICY',title:'Deposit & Withdrawal Policy',href:'/deposit-withdrawal-policy',version:'2026-11-15-v1'},
	{key:'PLATFORM_USAGE_POLICY',title:'Platform Usage Policy',href:'/platform-usage',version:'2026-11-15-v1'},
] as const;

export type RegistrationLegalDocumentKey=typeof REGISTRATION_LEGAL_DOCUMENTS[number]['key'];
export type LegalDocumentKey=RegistrationLegalDocumentKey|'COOKIE_POLICY'|'TRADING_AGREEMENT';

export function registrationLegalAcceptanceRows(input:{
	userId:string;
	termsVersion:string;
	privacyVersion:string;
	acceptedAt:Date;
	auditMetadata?:Record<string,string>;
}){
	return REGISTRATION_LEGAL_DOCUMENTS.map(document=>({
		userId:input.userId,
		documentKey:document.key,
		version:document.version==='terms'?input.termsVersion:document.version==='privacy'?input.privacyVersion:document.version,
		acceptedAt:input.acceptedAt,
		auditMetadata:input.auditMetadata,
	}));
}
