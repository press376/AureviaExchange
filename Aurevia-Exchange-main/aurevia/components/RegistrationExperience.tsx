'use client';

import {FormEvent,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {signIn,useSession} from 'next-auth/react';
import type {CountryCode} from 'libphonenumber-js';
import Image from 'next/image';
import Link from 'next/link';
import {
	ArrowRight,Check,ChevronLeft,ChevronRight,CircleCheck,Eye,EyeOff,
	FlaskConical,Globe2,Landmark,LockKeyhole,MapPin,ShieldCheck,UserRound,
} from 'lucide-react';
import CountrySelector from '@/components/CountrySelector';
import RegistrationTurnstile from '@/components/RegistrationTurnstile';
import {findCountry} from '@/lib/countries';
import {normalizePhoneE164,parseDateOfBirth} from '@/lib/registration-validation';

type AccountMode='DEMO'|'REAL'|'';
type LegalKey='termsAccepted'|'privacyAccepted'|'riskDisclosureAccepted'|'amlKycAccepted'|'depositWithdrawalAccepted'|'platformUsageAccepted';
type RegistrationDetails={
	firstName:string;middleName:string;lastName:string;dateOfBirth:string;
	nationality:string;residenceCountry:string;preferredLanguage:string;
	addressCountry:string;stateProvince:string;city:string;district:string;streetAddress:string;
	addressLine2:string;apartment:string;buildingName:string;postalCode:string;addressType:'RESIDENTIAL'|'BUSINESS'|'OTHER'|'';
	email:string;phoneCountry:string;phoneNumber:string;alternativePhone:string;preferredContactMethod:'EMAIL'|'PHONE'|'';
	accountMode:AccountMode;password:string;confirmPassword:string;
};
type LegalAcceptances=Record<LegalKey,boolean>;
type ExistingAccountIssue='account'|'unavailable'|'pending'|'phone';
type LocationState={code:string;name:string};
type CurrentLegalDocument={documentKey:string;title:string;href:string;version:string};

const initialDetails:RegistrationDetails={
	firstName:'',middleName:'',lastName:'',dateOfBirth:'',
	nationality:'',residenceCountry:'',preferredLanguage:'',
	addressCountry:'',stateProvince:'',city:'',district:'',streetAddress:'',
	addressLine2:'',apartment:'',buildingName:'',postalCode:'',addressType:'',
	email:'',phoneCountry:'',phoneNumber:'',alternativePhone:'',preferredContactMethod:'',
	accountMode:'',password:'',confirmPassword:'',
};
const legalItems:{key:LegalKey;label:string;href:string;description:string}[]=[
	{key:'termsAccepted',label:'Terms & Conditions',href:'/terms',description:'The terms governing access to Aurevia Exchange.'},
	{key:'privacyAccepted',label:'Privacy Policy',href:'/privacy',description:'How this application handles account and identity information.'},
	{key:'riskDisclosureAccepted',label:'Risk Disclosure',href:'/risk-disclosure',description:'The risks and limits of simulated trading, market data, and internal wallet records.'},
	{key:'amlKycAccepted',label:'Identity and account review',href:'/aml-kyc',description:'How REAL-mode identity checks and manual account reviews work.'},
	{key:'depositWithdrawalAccepted',label:'Deposits and withdrawals',href:'/deposit-withdrawal-policy',description:'How funding requests, approval, fees, and ledger settlement work.'},
	{key:'platformUsageAccepted',label:'Platform Usage Policy',href:'/platform-usage',description:'The distinction between DEMO practice and REAL account services.'},
];
const legalDocumentKeyByCheckbox:Record<LegalKey,string>={
	termsAccepted:'TERMS_AND_CONDITIONS',
	privacyAccepted:'PRIVACY_POLICY',
	riskDisclosureAccepted:'RISK_DISCLOSURE',
	amlKycAccepted:'AML_KYC_POLICY',
	depositWithdrawalAccepted:'DEPOSIT_WITHDRAWAL_POLICY',
	platformUsageAccepted:'PLATFORM_USAGE_POLICY',
};
const steps=[
	{title:'Personal information',description:'Tell us how to identify your Aurevia profile.',icon:UserRound},
	{title:'Residential address',description:'Enter your address as it is used in your country.',icon:MapPin},
	{title:'Contact information',description:'Add an email and optional international phone number.',icon:Globe2},
	{title:'Account selection',description:'Choose the account mode you want to start with.',icon:Landmark},
	{title:'Account security',description:'Create a strong password for your account.',icon:LockKeyhole},
	{title:'Legal agreements',description:'Review the documents and record each acknowledgement.',icon:ShieldCheck},
	{title:'Final review',description:'Check your details before creating your account.',icon:CircleCheck},
];
const addressLabels:Record<string,{region:string;postal:string;city:string}>={
	US:{region:'State',postal:'ZIP code',city:'City'},
	CA:{region:'Province or territory',postal:'Postal code',city:'City'},
	GB:{region:'County or region',postal:'Postcode',city:'Town or city'},
	NG:{region:'State',postal:'Postal code (if applicable)',city:'City or town'},
	IN:{region:'State',postal:'PIN code',city:'City'},
	AU:{region:'State or territory',postal:'Postcode',city:'Suburb or city'},
	BR:{region:'State',postal:'CEP',city:'City'},
	JP:{region:'Prefecture',postal:'Postal code',city:'City or ward'},
};

function createRegistrationRequestId(){
	if(typeof window==='undefined'||!window.crypto?.getRandomValues)return null;
	if(window.crypto.randomUUID)return window.crypto.randomUUID();
	const bytes=window.crypto.getRandomValues(new Uint8Array(16));
	bytes[6]=(bytes[6]&0x0f)|0x40;bytes[8]=(bytes[8]&0x3f)|0x80;
	const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
	return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function isRecord(value:unknown):value is Record<string,unknown>{
	return typeof value==='object'&&value!==null&&!Array.isArray(value);
}

function passwordChecks(password:string){
	return [
		{label:'At least 10 characters',ok:password.length>=10},
		{label:'One lowercase letter',ok:/[a-z]/.test(password)},
		{label:'One uppercase letter',ok:/[A-Z]/.test(password)},
		{label:'One number',ok:/[0-9]/.test(password)},
	];
}

function formatPhone(value:string,countryCode:string){
	if(!value.trim())return '';
	return normalizePhoneE164(value,countryCode as CountryCode)||'';
}

function dateInputMaximum(){return new Date().toISOString().slice(0,10)}

function summaryValue(value:string|null|undefined){
	return value?.trim()||'Not provided';
}

export default function RegistrationExperience({turnstileSiteKey}:{turnstileSiteKey:string}){
	const [details,setDetails]=useState(initialDetails);
	const [legal,setLegal]=useState<LegalAcceptances>({
		termsAccepted:false,privacyAccepted:false,riskDisclosureAccepted:false,amlKycAccepted:false,
		depositWithdrawalAccepted:false,platformUsageAccepted:false,
	});
	const [currentLegalDocuments,setCurrentLegalDocuments]=useState<CurrentLegalDocument[]>([]);
	const [additionalLegalAcceptances,setAdditionalLegalAcceptances]=useState<Record<string,boolean>>({});
	const [legalDocumentsLoading,setLegalDocumentsLoading]=useState(true);
	const [legalDocumentsError,setLegalDocumentsError]=useState('');
	const [step,setStep]=useState(0);
	const [stepError,setStepError]=useState('');
	const [error,setError]=useState('');
	const [notice,setNotice]=useState('');
	const [existingAccountIssue,setExistingAccountIssue]=useState<ExistingAccountIssue|null>(null);
	const [passwordVisible,setPasswordVisible]=useState(false);
	const [confirmationVisible,setConfirmationVisible]=useState(false);
	const [confirmAccuracy,setConfirmAccuracy]=useState(false);
	const [turnstileToken,setTurnstileToken]=useState<string|null>(null);
	const [turnstileReset,setTurnstileReset]=useState(0);
	const [states,setStates]=useState<LocationState[]>([]);
	const [statesLoading,setStatesLoading]=useState(false);
	const [locationError,setLocationError]=useState('');
	const [citySuggestions,setCitySuggestions]=useState<string[]>([]);
	const [citiesLoading,setCitiesLoading]=useState(false);
	const [busy,setBusy]=useState(false);
	const [success,setSuccess]=useState(false);
	const submissionInFlight=useRef(false);
	const {update:updateSession}=useSession();
	const phoneCountry=findCountry(details.phoneCountry);
	const labels=addressLabels[details.addressCountry]||{region:'State / province / region',postal:'Postal code (if applicable)',city:'City / town'};
	const knownLegalKeys=new Set(Object.values(legalDocumentKeyByCheckbox));
	const additionalLegalDocuments=currentLegalDocuments.filter(document=>!knownLegalKeys.has(document.documentKey));
	const legalAccepted=!legalDocumentsLoading&&!legalDocumentsError&&currentLegalDocuments.length>0
		&&Object.values(legal).every(Boolean)
		&&additionalLegalDocuments.every(document=>additionalLegalAcceptances[document.documentKey]===true);
	const passwordStatus=passwordChecks(details.password);
	const passwordStrength=passwordStatus.filter(item=>item.ok).length;
	const phone=formatPhone(details.phoneNumber,details.phoneCountry);
	const alternativePhone=formatPhone(details.alternativePhone,details.phoneCountry);
	useEffect(()=>{
		const controller=new AbortController();
		void fetch('/api/legal-documents/current',{signal:controller.signal,headers:{accept:'application/json'}})
			.then(async response=>{
				if(!response.ok)throw new Error('LEGAL_DOCUMENTS_UNAVAILABLE');
				const result:unknown=await response.json();
				if(!isRecord(result)||!Array.isArray(result.documents))throw new Error('INVALID_LEGAL_DOCUMENT_RESPONSE');
				const documents=result.documents.filter((item):item is CurrentLegalDocument=>isRecord(item)
					&&typeof item.documentKey==='string'&&typeof item.title==='string'
					&&typeof item.href==='string'&&typeof item.version==='string');
				if(!documents.length)throw new Error('LEGAL_DOCUMENTS_UNAVAILABLE');
				setCurrentLegalDocuments(documents);
				setLegalDocumentsError('');
			})
			.catch(exception=>{
				if(controller.signal.aborted)return;
				setLegalDocumentsError('Current legal documents could not be loaded. Refresh this page before continuing.');
				console.error('Current registration legal documents could not be loaded.',{errorType:exception instanceof Error?exception.name:'UnknownError'});
			})
			.finally(()=>{if(!controller.signal.aborted)setLegalDocumentsLoading(false)});
		return ()=>controller.abort();
	},[]);

	const update=useCallback(<K extends keyof RegistrationDetails>(key:K,value:RegistrationDetails[K])=>{
		setDetails(current=>({...current,[key]:value}));
		setStepError('');
		setError('');
	},[]);

	useEffect(()=>{
		if(!details.addressCountry){setStates([]);setLocationError('');return}
		const controller=new AbortController();
		setStatesLoading(true);setLocationError('');setStates([]);
		void fetch(`/api/registration/locations?country=${encodeURIComponent(details.addressCountry)}`,{signal:controller.signal,cache:'force-cache'})
			.then(async response=>{
				const result:unknown=await response.json();
				if(!response.ok||!isRecord(result)||!Array.isArray(result.states))throw new Error('Location suggestions are temporarily unavailable.');
				setStates(result.states.filter((item:unknown):item is LocationState=>isRecord(item)&&typeof item.code==='string'&&typeof item.name==='string'));
			})
			.catch(exception=>{if(!(exception instanceof DOMException&&exception.name==='AbortError'))setLocationError('Location suggestions are unavailable. You can enter your address manually.')})
			.finally(()=>{if(!controller.signal.aborted)setStatesLoading(false)});
		return()=>controller.abort();
	},[details.addressCountry]);

	useEffect(()=>{
		if(!details.addressCountry||details.city.trim().length<2){setCitySuggestions([]);setCitiesLoading(false);return}
		const controller=new AbortController();
		const timer=window.setTimeout(()=>{
			setCitiesLoading(true);
			const query=new URLSearchParams({country:details.addressCountry,state:details.stateProvince,query:details.city.trim()});
			void fetch(`/api/registration/locations?${query}`,{signal:controller.signal,cache:'force-cache'})
				.then(async response=>{
					const result:unknown=await response.json();
					if(!response.ok||!isRecord(result)||!Array.isArray(result.cities))throw new Error('Location suggestions are temporarily unavailable.');
					setCitySuggestions(result.cities.filter((item:unknown):item is string=>typeof item==='string'));
				})
				.catch(exception=>{if(!(exception instanceof DOMException&&exception.name==='AbortError'))setLocationError('Location suggestions are unavailable. You can enter your address manually.')})
				.finally(()=>{if(!controller.signal.aborted)setCitiesLoading(false)});
		},180);
		return()=>{window.clearTimeout(timer);controller.abort()};
	},[details.addressCountry,details.city,details.stateProvince]);

	function validateStep(target:number){
		const fail=(message:string)=>{setStepError(message);return false};
		if(target===0){
			if(!details.firstName.trim()||!details.lastName.trim())return fail('Enter your first and last name.');
			if(`${details.firstName} ${details.middleName} ${details.lastName}`.trim().length>120)return fail('Your full name must be 120 characters or fewer.');
			if(!parseDateOfBirth(details.dateOfBirth))return fail('Enter a valid date of birth. The date must not be in the future.');
			if(!details.residenceCountry)return fail('Choose your country of residence.');
		}
		if(target===1){
			if(!details.addressCountry)return fail('Choose the country for this residential address.');
			if(!details.streetAddress.trim())return fail('Enter your street address or a local address description.');
			if(!details.city.trim())return fail(`Enter your ${labels.city.toLocaleLowerCase()}.`);
		}
		if(target===2){
			if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email.trim()))return fail('Enter a valid email address.');
			if(details.phoneNumber.trim()&&(!details.phoneCountry||!phone))return fail('Choose the phone country and enter a valid international number.');
			if(details.alternativePhone.trim()&&(!details.phoneCountry||!alternativePhone))return fail('Enter a valid alternative phone number.');
			if(details.preferredContactMethod==='PHONE'&&!details.phoneNumber.trim())return fail('Add a phone number before choosing phone as your preferred contact.');
		}
		if(target===3&&!details.accountMode)return fail('Choose DEMO or REAL to continue.');
		if(target===4){
			if(passwordStatus.some(item=>!item.ok))return fail('Your password must include at least 10 characters, a lowercase letter, an uppercase letter, and a number.');
			if(details.password!==details.confirmPassword)return fail('Your password confirmation does not match.');
		}
		if(target===5&&!legalAccepted)return fail('Review and individually accept each required policy to continue.');
		if(target===6){
			if(!confirmAccuracy)return fail('Confirm that the registration information is accurate and complete.');
			if(!turnstileToken)return fail('Complete the Cloudflare security check before creating your account.');
		}
		setStepError('');
		return true;
	}

	function goToStep(nextStep:number){
		if(nextStep>step&&!validateStep(step))return;
		setStep(Math.min(steps.length-1,Math.max(0,nextStep)));
		setStepError('');
		setError('');
		window.scrollTo({top:0,behavior:'smooth'});
	}

	function chooseResidence(code:string){
		const country=findCountry(code);
		update('residenceCountry',code);
		if(country&&!details.addressCountry)update('addressCountry',code);
		if(country&&!details.phoneCountry)update('phoneCountry',code);
	}

	function chooseAddressCountry(code:string){
		update('addressCountry',code);
		update('stateProvince','');update('city','');update('district','');update('postalCode','');
	}

	function updateLegal(key:LegalKey,value:boolean){
		setLegal(current=>({...current,[key]:value}));
		setStepError('');setError('');
	}

	async function submit(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(busy||submissionInFlight.current||!validateStep(6))return;
		setError('');setNotice('');setExistingAccountIssue(null);
		const requestId=createRegistrationRequestId();
		submissionInFlight.current=true;setBusy(true);
		const controller=new AbortController();
		let timedOut=false;
		const requestTimeout=window.setTimeout(()=>{timedOut=true;controller.abort()},30_000);
		try{
			const payload={
				firstName:details.firstName.trim(),
				middleName:details.middleName.trim(),
				lastName:details.lastName.trim(),
				name:[details.firstName,details.middleName,details.lastName].map(part=>part.trim()).filter(Boolean).join(' '),
				dateOfBirth:details.dateOfBirth,
				nationalityCode:details.nationality||undefined,
				countryCode:details.residenceCountry,
				preferredLanguage:details.preferredLanguage.trim()||undefined,
				address:{
					countryCode:details.addressCountry,
					stateProvince:details.stateProvince.trim(),
					city:details.city.trim(),
					district:details.district.trim(),
					line1:details.streetAddress.trim(),
					line2:details.addressLine2.trim(),
					apartment:details.apartment.trim(),
					buildingName:details.buildingName.trim(),
					postalCode:details.postalCode.trim(),
					type:details.addressType||undefined,
				},
				email:details.email.trim(),
				phone:phone||'',
				alternativePhone:alternativePhone||'',
				preferredContactMethod:details.preferredContactMethod||undefined,
				password:details.password,
				accountMode:details.accountMode,
				legal,
				legalAcceptances:currentLegalDocuments.map(({documentKey,version})=>({documentKey,version})),
				turnstileToken,
				website:'',
			};
			let response:Response;
			try{
				response=await fetch('/api/register',{
					method:'POST',
					headers:{'content-type':'application/json','accept':'application/json',...(requestId?{'x-aurevia-request-id':requestId}:{})},
					body:JSON.stringify(payload),
					signal:controller.signal,
				});
			}catch(exception){
				const referenceId=requestId||createRegistrationRequestId();
				setTurnstileToken(null);
				setTurnstileReset(value=>value+1);
				console.warn('[registration] Browser request did not receive an API response.',{
					...(referenceId?{requestId:referenceId,referenceId}:{}),
					endpoint:'/api/register',
					reason:timedOut?'timeout':exception instanceof Error?exception.name:'UNKNOWN_ERROR',
					failureTimestamp:new Date().toISOString(),
				});
				setError(timedOut
					?`The registration request timed out. Your form details are still here; check your connection and retry.${referenceId?` Reference: ${referenceId}`:''}`
					:`Unable to connect to the registration service. Your form details are still here; check your connection and retry.${referenceId?` Reference: ${referenceId}`:''}`);
				return;
			}
			let result:Record<string,unknown>;
			try{
				const body:unknown=await response.json();
				if(!isRecord(body))throw new Error('INVALID_RESPONSE_BODY');
				result=body;
			}catch{
				setError(`The registration service returned an unexpected response (HTTP ${response.status}). Please retry.${requestId?` Reference: ${requestId}`:''}`);
				return;
			}
			if(!response.ok){
				if(result.code==='LEGAL_DOCUMENTS_CHANGED'){
					try{
						const refreshedResponse=await fetch('/api/legal-documents/current',{cache:'no-store',headers:{accept:'application/json'}});
						const refreshed:unknown=await refreshedResponse.json();
						if(!refreshedResponse.ok||!isRecord(refreshed)||!Array.isArray(refreshed.documents))throw new Error('LEGAL_DOCUMENTS_UNAVAILABLE');
						const latest=refreshed.documents.filter((item):item is CurrentLegalDocument=>isRecord(item)
							&&typeof item.documentKey==='string'&&typeof item.title==='string'
							&&typeof item.href==='string'&&typeof item.version==='string');
						const previousByKey=new Map(currentLegalDocuments.map(document=>[document.documentKey,document.version]));
						const latestByKey=new Map(latest.map(document=>[document.documentKey,document.version]));
						setLegal(current=>Object.fromEntries(Object.entries(legalDocumentKeyByCheckbox).map(([key,documentKey])=>[
							key,previousByKey.get(documentKey)===latestByKey.get(documentKey)?current[key as LegalKey]:false,
						])) as LegalAcceptances);
						setAdditionalLegalAcceptances(current=>Object.fromEntries(latest
							.filter(document=>!knownLegalKeys.has(document.documentKey))
							.map(document=>[document.documentKey,previousByKey.get(document.documentKey)===document.version&&current[document.documentKey]===true])));
						setCurrentLegalDocuments(latest);
						setLegalDocumentsError('');
						setError('The legal documents changed during registration. Review and accept any updated or newly required versions.');
					}catch{
						setLegalDocumentsError('Current legal documents could not be refreshed. Reload this page before continuing.');
						setError('The legal documents changed during registration and could not be refreshed.');
					}
					return;
				}
				if(result.code==='ACCOUNT_ACCESS_REQUIRED'||result.code==='ACCOUNT_ALREADY_EXISTS')setExistingAccountIssue('account');
				else if(result.code==='ACCOUNT_UNAVAILABLE')setExistingAccountIssue('unavailable');
				else if(result.code==='REGISTRATION_IN_PROGRESS')setExistingAccountIssue('pending');
				else if(result.code==='PHONE_ALREADY_IN_USE')setExistingAccountIssue('phone');
				if(typeof result.error==='string'&&result.error.toLocaleLowerCase().includes('security check')){
					setTurnstileToken(null);
					setTurnstileReset(value=>value+1);
				}
				const retryAfter=Number(response.headers.get('Retry-After')||result.retryAfterSeconds);
				const retryMessage=response.status===429&&Number.isFinite(retryAfter)&&retryAfter>0
					?` You can retry in ${retryAfter>=60?`${Math.ceil(retryAfter/60)} minute(s)`:`${retryAfter} second(s)`}.`
					:'';
				const referenceId=typeof result.referenceId==='string'?result.referenceId:typeof result.requestId==='string'?result.requestId:requestId;
				setError(`${typeof result.error==='string'?result.error:'Account creation failed.'}${referenceId?` (Reference: ${referenceId})`:''}${retryMessage}`);
				return;
			}
			if((result.created!==true&&result.accountMatched!==true)||typeof result.email!=='string'){
				setError(`The registration service returned an incomplete response. Please retry.${requestId?` Reference: ${requestId}`:''}`);
				return;
			}
			const login=await signIn('credentials',{
				username:result.email,email:result.email,password:details.password,
				replaceSession:'false',redirect:false,
			});
			if(!login?.ok){
				setExistingAccountIssue('account');
				setError('Your account was created, but automatic sign-in failed. Sign in with your new email and password to continue.');
				return;
			}
			try{await updateSession()}catch(exception){console.error('Session refresh after registration failed.',exception instanceof Error?exception.name:'UnknownError')}
			setSuccess(true);
			window.setTimeout(()=>window.location.replace('/dashboard'),700);
		}catch(exception){
			const referenceId=requestId||createRegistrationRequestId();
			console.error('[registration] Client could not process the API response.',{
				...(referenceId?{requestId:referenceId,referenceId}:{}),
				endpoint:'/api/register',
				errorName:exception instanceof Error?exception.name:'UnknownError',
				failureTimestamp:new Date().toISOString(),
			});
			setError(`Registration could not continue after the service response. Please retry.${referenceId?` Reference: ${referenceId}`:''}`);
		}finally{
			window.clearTimeout(requestTimeout);submissionInFlight.current=false;setBusy(false);
		}
	}

	const countryName=(code:string)=>findCountry(code)?.name||'Not provided';
	const regionNames=useMemo(()=>states.map(item=>item.name),[states]);
	const accountDescription=details.accountMode==='DEMO'
		?'$5,000 simulated starting balance · no deposits or withdrawals · demo funds have no cash value.'
		:details.accountMode==='REAL'
			?'$0 starting balance · funding requires administrator approval · Didit identity verification may be required. Orders use configured simulated or sandbox execution, not live brokerage execution.'
			:'Not selected';

	if(success)return <main className="registration-success">
		<section className="registration-success-card" role="status" aria-live="polite">
			<span className="registration-success-icon"><CircleCheck size={26}/></span>
			<p className="registration-eyebrow">AUREVIA EXCHANGE · ACCOUNT CREATED</p>
			<h1>Welcome to Aurevia.</h1>
			<p>Your account is ready. Taking you to your secure dashboard…</p>
			<Link className="registration-primary-button" href="/dashboard">Continue to dashboard <ArrowRight size={16}/></Link>
		</section>
	</main>;

	const currentStep=steps[step];
	const StepIcon=currentStep.icon;

	return <main className="registration-app">
		<header className="registration-mobile-header">
			<Link href="/" className="registration-brand">
				<Image src="/aurevia-logo.png" alt="" width={39} height={39}/>
				<span><b>Aurevia</b><small>EXCHANGE</small></span>
			</Link>
			<Link href="/login" className="registration-login-link">Sign in</Link>
		</header>
		<div className="registration-layout">
			<aside className="registration-intro" aria-label="About Aurevia account setup">
				<Link href="/" className="registration-brand registration-desktop-brand">
					<Image src="/aurevia-logo.png" alt="" width={48} height={48}/>
					<span><b>Aurevia</b><small>EXCHANGE</small></span>
				</Link>
				<div className="registration-intro-copy">
					<p className="registration-eyebrow">A MORE CONSIDERED WAY TO BEGIN</p>
					<h1>Welcome to<br/><span>Aurevia Exchange.</span></h1>
					<p className="registration-intro-lead">Create a secure account designed around clarity, control, and considered financial decisions.</p>
				</div>
				<ul className="registration-benefits">
					<li><span><ShieldCheck size={17}/></span><div><b>Privacy-led by design</b><small>Your password is protected and sensitive documents remain private.</small></div></li>
					<li><span><FlaskConical size={17}/></span><div><b>Start in practice mode</b><small>Explore simulated trading with $5,000 in DEMO funds.</small></div></li>
					<li><span><Landmark size={17}/></span><div><b>Clear account separation</b><small>DEMO and REAL account activity stays distinct.</small></div></li>
					<li><span><Globe2 size={17}/></span><div><b>Built for global details</b><small>Enter your address in a format that works for your country.</small></div></li>
				</ul>
				<div className="registration-intro-security"><LockKeyhole size={15}/><span>Secure registration · Your contact details are not marked as verified by signup.</span></div>
				<div className="registration-intro-progress" aria-label={`Step ${step+1} of ${steps.length}`}>
					<div className="registration-intro-progress-label"><span>ACCOUNT SETUP</span><b>{String(step+1).padStart(2,'0')} / {String(steps.length).padStart(2,'0')}</b></div>
					<div className="registration-progress-track"><span style={{width:`${((step+1)/steps.length)*100}%`}}/></div>
					<p>{currentStep.title}</p>
				</div>
			</aside>

			<section className="registration-panel" aria-labelledby="registration-title">
				<div className="registration-panel-top">
					<p className="registration-eyebrow">SECURE ACCOUNT SETUP</p>
					<span className="registration-step-count">STEP {String(step+1).padStart(2,'0')} OF {String(steps.length).padStart(2,'0')}</span>
				</div>
				<h1 className="registration-mobile-title">Create your Aurevia account</h1>
				<nav className="registration-stepper" aria-label="Registration progress">
					{steps.map((item,index)=>{
						const Icon=item.icon;
						return <button type="button" key={item.title} onClick={()=>goToStep(index)} aria-current={index===step?'step':undefined} aria-label={`Step ${index+1}: ${item.title}`} className={`registration-step-dot ${index===step?'is-current':''} ${index<step?'is-complete':''}`}>
							<span>{index<step?<Check size={14}/>:<Icon size={15}/>}</span><small>{index+1}</small>
						</button>;
					})}
				</nav>
				<div className="registration-step-heading" aria-live="polite">
					<span className="registration-step-heading-icon"><StepIcon size={20}/></span>
					<div><h2 id="registration-title">{currentStep.title}</h2><p>{currentStep.description}</p></div>
				</div>

				<form className="registration-wizard-form" onSubmit={submit} noValidate>
					{step===0&&<fieldset className="registration-step-content" aria-labelledby="registration-title">
						<legend className="sr-only">Personal information</legend>
						<div className="registration-field-grid">
							<label className="registration-field">First name <span aria-hidden="true">*</span><input className="auth-input" autoComplete="given-name" maxLength={60} value={details.firstName} onChange={event=>update('firstName',event.target.value)}/></label>
							<label className="registration-field">Middle name <small>Optional</small><input className="auth-input" autoComplete="additional-name" maxLength={60} value={details.middleName} onChange={event=>update('middleName',event.target.value)}/></label>
							<label className="registration-field">Last name <span aria-hidden="true">*</span><input className="auth-input" autoComplete="family-name" maxLength={60} value={details.lastName} onChange={event=>update('lastName',event.target.value)}/></label>
							<label className="registration-field">Date of birth <span aria-hidden="true">*</span><input className="auth-input auth-date-input" type="date" autoComplete="bday" max={dateInputMaximum()} value={details.dateOfBirth} onChange={event=>update('dateOfBirth',event.target.value)}/><small>Required for identity-review records. The date must not be in the future.</small></label>
							<div className="registration-field"><span>Nationality <small>Optional</small></span><CountrySelector label="Nationality" value={details.nationality} onChange={code=>update('nationality',code)}/></div>
							<div className="registration-field"><span>Country of residence <span aria-hidden="true">*</span></span><CountrySelector label="Country of residence" value={details.residenceCountry} onChange={chooseResidence} required/></div>
							<label className="registration-field">Preferred language <small>Optional</small><input className="auth-input" list="registration-languages" maxLength={35} placeholder="e.g. en, fr-CA, ar" value={details.preferredLanguage} onChange={event=>update('preferredLanguage',event.target.value)}/><datalist id="registration-languages"><option value="en"/><option value="fr"/><option value="es"/><option value="ar"/><option value="hi"/><option value="pt"/><option value="zh"/></datalist></label>
						</div>
					</fieldset>}

					{step===1&&<fieldset className="registration-step-content" aria-labelledby="registration-title">
						<legend className="sr-only">Residential address</legend>
						<p className="registration-helper"><MapPin size={15}/> Enter the address format used in your country. Region and postal fields are optional when they are not applicable.</p>
						<div className="registration-field-grid">
							<div className="registration-field"><span>Address country <span aria-hidden="true">*</span></span><CountrySelector label="Residential address country" value={details.addressCountry} onChange={chooseAddressCountry} required/></div>
							<label className="registration-field">{labels.region} <small>Optional where not used</small><input className="auth-input" list="registration-regions" autoComplete="address-level1" maxLength={100} value={details.stateProvince} onChange={event=>{update('stateProvince',event.target.value);update('city','')}}/><datalist id="registration-regions">{regionNames.map(region=><option key={region} value={region}/>)}</datalist><small>{statesLoading?'Loading regional suggestions…':states.length?'Suggestions are available; manual entry is also accepted.':'Enter your region manually if applicable.'}</small></label>
							<label className="registration-field">{labels.city} <span aria-hidden="true">*</span><input className="auth-input" list="registration-cities" autoComplete="address-level2" maxLength={100} value={details.city} onChange={event=>update('city',event.target.value)}/><datalist id="registration-cities">{citySuggestions.map((city,index)=><option key={`${city}-${index}`} value={city}/>)}</datalist><small>{citiesLoading?'Searching local suggestions…':'Suggestions are not address verification. Manual entry is accepted.'}</small></label>
							<label className="registration-field">District / county / local area <small>Optional</small><input className="auth-input" autoComplete="address-level3" maxLength={100} value={details.district} onChange={event=>update('district',event.target.value)}/></label>
							<label className="registration-field registration-field-wide">Street address / house number <span aria-hidden="true">*</span><input className="auth-input" autoComplete="address-line1" maxLength={160} value={details.streetAddress} onChange={event=>update('streetAddress',event.target.value)} placeholder="Street, house number, or local address description"/></label>
							<label className="registration-field">Address line 2 <small>Optional</small><input className="auth-input" autoComplete="address-line2" maxLength={160} value={details.addressLine2} onChange={event=>update('addressLine2',event.target.value)}/></label>
							<label className="registration-field">Apartment / suite / unit <small>Optional</small><input className="auth-input" autoComplete="address-line2" maxLength={80} value={details.apartment} onChange={event=>update('apartment',event.target.value)}/></label>
							<label className="registration-field">Building name <small>Optional</small><input className="auth-input" maxLength={120} value={details.buildingName} onChange={event=>update('buildingName',event.target.value)}/></label>
							<label className="registration-field">{labels.postal} <small>Optional where not used</small><input className="auth-input" autoComplete="postal-code" maxLength={32} value={details.postalCode} onChange={event=>update('postalCode',event.target.value)}/></label>
							<label className="registration-field">Address type <small>Optional</small><select className="auth-input" value={details.addressType} onChange={event=>update('addressType',event.target.value as RegistrationDetails['addressType'])}><option value="">Select type</option><option value="RESIDENTIAL">Residential</option><option value="BUSINESS">Business</option><option value="OTHER">Other</option></select></label>
						</div>
						{locationError&&<p className="registration-location-fallback" role="status">{locationError}</p>}
					</fieldset>}

					{step===2&&<fieldset className="registration-step-content" aria-labelledby="registration-title">
						<legend className="sr-only">Contact information</legend>
						<div className="registration-field-grid">
							<label className="registration-field registration-field-wide">Email address <span aria-hidden="true">*</span><input className="auth-input" type="email" autoComplete="email" maxLength={254} value={details.email} onChange={event=>update('email',event.target.value)}/><small>Used for sign-in and password recovery. Signup does not mark your email as verified.</small></label>
							<div className="registration-field registration-field-wide"><span>Phone number <small>Optional · no signup OTP required</small></span><div className="registration-phone-row"><CountrySelector label="Phone country and calling code" value={details.phoneCountry} onChange={code=>update('phoneCountry',code)} showDialCode/><input className="auth-input" type="tel" inputMode="tel" autoComplete="tel-national" value={details.phoneNumber} onChange={event=>update('phoneNumber',event.target.value)} placeholder={phoneCountry?`Number for ${phoneCountry.name}`:'Select a country first'}/></div><small>Country calling code is included in validation. A valid format does not confirm phone ownership.</small></div>
							<label className="registration-field registration-field-wide">Alternative phone number <small>Optional</small><input className="auth-input" type="tel" autoComplete="tel" inputMode="tel" value={details.alternativePhone} onChange={event=>update('alternativePhone',event.target.value)} placeholder="Uses the selected calling code"/></label>
							<label className="registration-field">Preferred contact method <small>Optional</small><select className="auth-input" value={details.preferredContactMethod} onChange={event=>update('preferredContactMethod',event.target.value as RegistrationDetails['preferredContactMethod'])}><option value="">No preference</option><option value="EMAIL">Email</option><option value="PHONE" disabled={!details.phoneNumber.trim()}>Phone</option></select></label>
						</div>
					</fieldset>}

					{step===3&&<fieldset className="registration-step-content" aria-labelledby="registration-title">
						<legend className="sr-only">Account selection</legend>
						<p className="registration-helper"><Landmark size={15}/> Choose an account mode to begin. This selection does not grant identity approval or access to REAL financial services.</p>
						<div className="registration-account-options" role="radiogroup" aria-label="Choose account type">
							<label className={`registration-account-card ${details.accountMode==='DEMO'?'is-selected':''}`}>
								<input type="radio" name="accountMode" value="DEMO" checked={details.accountMode==='DEMO'} onChange={()=>update('accountMode','DEMO')}/>
								<span className="registration-account-icon"><FlaskConical size={21}/></span>
								<span className="registration-account-copy"><small>SIMULATED PRACTICE</small><b>DEMO account</b><span>$5,000 simulated starting balance. Practice with simulated orders. No deposits or withdrawals; DEMO funds have no cash value.</span></span>
								<span className="registration-account-check"><Check size={15}/></span>
							</label>
							<label className={`registration-account-card ${details.accountMode==='REAL'?'is-selected':''}`}>
								<input type="radio" name="accountMode" value="REAL" checked={details.accountMode==='REAL'} onChange={()=>update('accountMode','REAL')}/>
								<span className="registration-account-icon"><Landmark size={21}/></span>
								<span className="registration-account-copy"><small>IDENTITY REVIEW MAY APPLY</small><b>REAL account</b><span>$0 initial balance. Funding requires administrator review and approval. Didit identity verification may be required for eligible services. Orders use configured simulated or sandbox execution, not live brokerage execution.</span></span>
								<span className="registration-account-check"><Check size={15}/></span>
							</label>
						</div>
					</fieldset>}

					{step===4&&<fieldset className="registration-step-content" aria-labelledby="registration-title">
						<legend className="sr-only">Account security</legend>
						<div className="registration-field-grid">
							<label className="registration-field registration-field-wide" htmlFor="registration-password">Password <span aria-hidden="true">*</span><div className="registration-password-wrap"><input id="registration-password" className="auth-input" type={passwordVisible?'text':'password'} autoComplete="new-password" minLength={10} maxLength={128} value={details.password} onChange={event=>update('password',event.target.value)} aria-describedby="registration-password-checklist"/><button className="registration-password-toggle" type="button" aria-label={passwordVisible?'Hide password':'Show password'} aria-pressed={passwordVisible} onClick={()=>setPasswordVisible(value=>!value)}>{passwordVisible?<EyeOff size={17}/>:<Eye size={17}/>}</button></div></label>
							<label className="registration-field registration-field-wide" htmlFor="registration-confirm-password">Confirm password <span aria-hidden="true">*</span><div className="registration-password-wrap"><input id="registration-confirm-password" className="auth-input" type={confirmationVisible?'text':'password'} autoComplete="new-password" maxLength={128} value={details.confirmPassword} onChange={event=>update('confirmPassword',event.target.value)}/><button className="registration-password-toggle" type="button" aria-label={confirmationVisible?'Hide password confirmation':'Show password confirmation'} aria-pressed={confirmationVisible} onClick={()=>setConfirmationVisible(value=>!value)}>{confirmationVisible?<EyeOff size={17}/>:<Eye size={17}/>}</button></div></label>
						</div>
						<div className="registration-password-strength" aria-live="polite"><div className="registration-password-strength-head"><b>Password strength</b><span>{details.password?passwordStrength===4?'Strong':passwordStrength>=2?'Building':'Needs work':'Not entered'}</span></div><div className="registration-strength-bars" aria-hidden="true">{[1,2,3,4].map(level=><span key={level} className={passwordStrength>=level?'is-filled':''}/>)}</div></div>
						<ul id="registration-password-checklist" className="registration-password-checklist">{passwordStatus.map(item=><li className={item.ok?'is-met':''} key={item.label}><Check size={14}/>{item.label}</li>)}</ul>
						{details.confirmPassword&&<p className={`registration-password-match ${details.password===details.confirmPassword?'is-match':''}`} role="status">{details.password===details.confirmPassword?'Passwords match.':'Passwords do not match yet.'}</p>}
						<p className="registration-helper"><LockKeyhole size={15}/> Your password is sent only through the existing registration endpoint, hashed server-side, and never saved in browser storage.</p>
					</fieldset>}

					{step===5&&<fieldset className="registration-step-content" aria-labelledby="registration-title">
						<legend className="sr-only">Legal agreements</legend>
						<p className="registration-helper">Open any policy in a new tab; your registration progress will remain on this page. Each acknowledgement is recorded by the server with the accepted document version and timestamp.</p>
						{legalDocumentsLoading&&<p role="status">Loading current legal document versions…</p>}
						{legalDocumentsError&&<p role="alert">{legalDocumentsError}</p>}
						<div className="registration-legal-list">
							{legalItems.map(item=>{
								const version=currentLegalDocuments.find(document=>document.documentKey===legalDocumentKeyByCheckbox[item.key])?.version;
								return <label className={`registration-legal-item ${legal[item.key]?'is-accepted':''}`} key={item.key}>
									<input type="checkbox" checked={legal[item.key]} onChange={event=>updateLegal(item.key,event.target.checked)} disabled={legalDocumentsLoading||Boolean(legalDocumentsError)}/>
									<span className="registration-legal-copy"><b>{item.label}</b><small>{item.description}{version?` Current version: ${version}.`:''}</small></span>
									<Link href={currentLegalDocuments.find(document=>document.documentKey===legalDocumentKeyByCheckbox[item.key])?.href||item.href} target="_blank" rel="noopener noreferrer" className="registration-legal-link">Review <ArrowRight size={13}/></Link>
								</label>
							})}
							{additionalLegalDocuments.map(document=><label className={`registration-legal-item ${additionalLegalAcceptances[document.documentKey]?'is-accepted':''}`} key={document.documentKey}>
								<input type="checkbox" checked={additionalLegalAcceptances[document.documentKey]===true} onChange={event=>setAdditionalLegalAcceptances(current=>({...current,[document.documentKey]:event.target.checked}))} disabled={legalDocumentsLoading||Boolean(legalDocumentsError)}/>
								<span className="registration-legal-copy"><b>{document.title}</b><small>Required policy · Current version: {document.version}.</small></span>
								<Link href={document.href} target="_blank" rel="noopener noreferrer" className="registration-legal-link">Review <ArrowRight size={13}/></Link>
							</label>)}
						</div>
						<p className="registration-legal-note">Required acknowledgements are not preselected. Your choices are saved only when registration succeeds.</p>
					</fieldset>}

					{step===6&&<fieldset className="registration-step-content registration-review" aria-labelledby="registration-title">
						<legend className="sr-only">Final review</legend>
						<p className="registration-helper"><CircleCheck size={15}/> Verify each section before you create your account. Use Edit to return to a section without losing your entries.</p>
						<section className="registration-review-section"><div className="registration-review-heading"><h3>Personal information</h3><button type="button" onClick={()=>goToStep(0)}>Edit</button></div><dl><div><dt>Name</dt><dd>{summaryValue([details.firstName,details.middleName,details.lastName].filter(Boolean).join(' '))}</dd></div><div><dt>Date of birth</dt><dd>{summaryValue(details.dateOfBirth)}</dd></div><div><dt>Nationality</dt><dd>{countryName(details.nationality)}</dd></div><div><dt>Country of residence</dt><dd>{countryName(details.residenceCountry)}</dd></div></dl></section>
						<section className="registration-review-section"><div className="registration-review-heading"><h3>Residential address</h3><button type="button" onClick={()=>goToStep(1)}>Edit</button></div><dl><div><dt>Address</dt><dd>{summaryValue([details.streetAddress,details.addressLine2,details.apartment,details.buildingName,details.city,details.district,details.stateProvince,details.postalCode,countryName(details.addressCountry)].filter(Boolean).join(', '))}</dd></div><div><dt>Address type</dt><dd>{summaryValue(details.addressType||'RESIDENTIAL')}</dd></div></dl></section>
						<section className="registration-review-section"><div className="registration-review-heading"><h3>Contact details</h3><button type="button" onClick={()=>goToStep(2)}>Edit</button></div><dl><div><dt>Email</dt><dd>{summaryValue(details.email)}</dd></div><div><dt>Phone</dt><dd>{phone||'Not provided'} · unverified</dd></div><div><dt>Alternative phone</dt><dd>{alternativePhone||'Not provided'}</dd></div><div><dt>Preferred contact</dt><dd>{summaryValue(details.preferredContactMethod||'No preference')}</dd></div></dl></section>
						<section className="registration-review-section"><div className="registration-review-heading"><h3>Account type</h3><button type="button" onClick={()=>goToStep(3)}>Edit</button></div><p><b>{details.accountMode||'Not selected'} account</b><span>{accountDescription}</span></p></section>
						<section className="registration-review-section"><div className="registration-review-heading"><h3>Legal acknowledgements</h3><button type="button" onClick={()=>goToStep(5)}>Edit</button></div><ul className="registration-review-legal">{legalItems.map(item=><li key={item.key}><Check size={13}/>{item.label} · {legal[item.key]?'Acknowledged':'Not acknowledged'}</li>)}{additionalLegalDocuments.map(document=><li key={document.documentKey}><Check size={13}/>{document.title} · {additionalLegalAcceptances[document.documentKey]?'Acknowledged':'Not acknowledged'}</li>)}</ul></section>
						<label className="registration-accuracy"><input type="checkbox" checked={confirmAccuracy} onChange={event=>{setConfirmAccuracy(event.target.checked);setStepError('')}}/><span>I confirm that the information supplied during registration is accurate and complete.</span></label>
						<div className="registration-captcha">
							<p>Complete the security check to continue. This check helps prevent automated signups and does not verify your identity or contact details.</p>
							<RegistrationTurnstile key={turnstileReset} siteKey={turnstileSiteKey} onToken={setTurnstileToken}/>
						</div>
					</fieldset>}

					<div className="registration-live-messages" aria-live="polite">
						{stepError&&<p className="registration-field-error" role="alert">{stepError}</p>}
						{error&&<p className="registration-field-error" role="alert">{error}</p>}
						{notice&&<p className="registration-field-notice" role="status">{notice}</p>}
						{existingAccountIssue==='account'&&<p className="registration-existing-account">You can <Link href="/login" onClick={()=>{try{window.sessionStorage.setItem('aurevia-signin-email',details.email.trim())}catch(exception){console.warn('Unable to preserve email for registration sign-in handoff.',{errorName:exception instanceof Error?exception.name:'UnknownError'})}}}>sign in</Link> or <Link href="/forgot-password">reset your password</Link>.</p>}
						{existingAccountIssue==='unavailable'&&<p className="registration-existing-account">This account was not changed or reactivated. <Link href="/support">Contact support</Link>.</p>}
						{existingAccountIssue==='pending'&&<p className="registration-existing-account">Your account may already have been created. Try signing in or wait briefly before retrying.</p>}
						{existingAccountIssue==='phone'&&<p className="registration-existing-account">This phone is associated with another account. Use another number or leave it blank.</p>}
					</div>

					<div className="registration-wizard-actions">
						<button className="registration-secondary-button" type="button" disabled={step===0||busy} onClick={()=>goToStep(step-1)}><ChevronLeft size={17}/> Previous</button>
						{step<steps.length-1
							?<button className="registration-primary-button" type="button" onClick={()=>goToStep(step+1)}>Continue <ChevronRight size={17}/></button>
							:<button className="registration-primary-button registration-create-button" type="submit" disabled={busy||!turnstileToken||!confirmAccuracy||!legalAccepted} aria-busy={busy}>{busy?'Creating secure account…':'Create account'} <ArrowRight size={16}/></button>}
					</div>
				</form>
				<div className="registration-panel-footer"><span><ShieldCheck size={15}/> Your details are protected by Aurevia’s account controls.</span><span>Already registered? <Link href="/login">Sign in</Link></span></div>
			</section>
		</div>
	</main>;
}
