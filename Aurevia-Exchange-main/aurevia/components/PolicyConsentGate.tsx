'use client';

import {FormEvent,useEffect,useRef,useState,type ReactNode} from 'react';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useSession} from 'next-auth/react';

type ConsentState='checking'|'required'|'accepted'|'error'|'inactive';
type ConsentDocument={documentKey:string;title:string;href:string;version:string;accepted:boolean;acceptedAt:string|null;content:string|null};
type ConsentResponse={accepted?:boolean;version?:string;error?:string;documents?:ConsentDocument[];outstanding?:ConsentDocument[]};
type DeviceAcceptanceMarker={userId:string;documents:Array<{documentKey:string;version:string;acceptedAt:string}>};
const policyPaths=new Set(['/terms','/privacy','/risk-disclosure','/aml-kyc','/deposit-withdrawal-policy','/platform-usage','/legal-centre']);
const markerKey=(userId:string)=>`aurevia-policy-consent:v1:${userId}`;

function readDeviceMarker(userId:string):DeviceAcceptanceMarker|null{
	try{
		const raw=localStorage.getItem(markerKey(userId));
		if(!raw)return null;
		const marker=JSON.parse(raw) as DeviceAcceptanceMarker;
		if(marker.userId!==userId||!Array.isArray(marker.documents)||marker.documents.length===0)return null;
		if(!marker.documents.every(document=>typeof document.documentKey==='string'&&typeof document.version==='string'&&typeof document.acceptedAt==='string'&&!Number.isNaN(Date.parse(document.acceptedAt))))return null;
		return marker;
	}catch{return null;}
}

function saveDeviceMarker(userId:string,documents:ConsentDocument[]){
	const acceptedDocuments=documents.flatMap(document=>document.accepted&&document.acceptedAt
		?[{documentKey:document.documentKey,version:document.version,acceptedAt:document.acceptedAt}]
		:[]);
	if(!documents.length||acceptedDocuments.length!==documents.length)return;
	const marker:DeviceAcceptanceMarker={userId,documents:acceptedDocuments};
	try{localStorage.setItem(markerKey(userId),JSON.stringify(marker))}catch{}
}

function clearDeviceMarker(userId:string){
	try{localStorage.removeItem(markerKey(userId))}catch{}
}

export default function PolicyConsentGate({children,initialUserId}:{children:ReactNode;initialUserId:string|null}){
	const pathname=usePathname();
	const {data:session,status}=useSession();
	const dialogRef=useRef<HTMLDialogElement>(null);
	const activeUserRef=useRef<string|null>(null);
	const [state,setState]=useState<ConsentState>('inactive');
	const [checked,setChecked]=useState(false);
	const [outstanding,setOutstanding]=useState<ConsentDocument[]>([]);
	const [busy,setBusy]=useState(false);
	const [error,setError]=useState('');
	const [retryKey,setRetryKey]=useState(0);
	const [deviceAcceptanceKnown,setDeviceAcceptanceKnown]=useState(false);
	const userId=session?.user?.id;
	const eligible=status==='authenticated'&&(session?.user?.role==='USER'||session?.user?.role==='ADMIN')&&Boolean(userId)&&!policyPaths.has(pathname);
	const checkingSession=status==='loading'&&Boolean(initialUserId)&&!policyPaths.has(pathname);
	const visible=eligible&&(state==='required'||state==='error');
	const blockContent=checkingSession||eligible&&state!=='accepted';

	useEffect(()=>{
		if(!eligible||!userId){
			activeUserRef.current=null;
			setState('inactive');
			setChecked(false);
			setOutstanding([]);
			setError('');
			setDeviceAcceptanceKnown(false);
			return;
		}
		const controller=new AbortController();
		if(activeUserRef.current!==userId){
			activeUserRef.current=userId;
			setDeviceAcceptanceKnown(Boolean(readDeviceMarker(userId)));
			setState('checking');
			setChecked(false);
			setOutstanding([]);
			setError('');
		}
		void fetch('/api/policy-consent',{cache:'no-store',signal:controller.signal})
			.then(async response=>{
				const result=await response.json() as ConsentResponse;
				if(!response.ok)throw new Error(result.error||'Terms acceptance status is temporarily unavailable.');
				if(!Array.isArray(result.documents)||!Array.isArray(result.outstanding))throw new Error('Current legal document versions are unavailable.');
				setOutstanding(result.outstanding);
				if(result.accepted){
					saveDeviceMarker(userId,result.documents);
					setDeviceAcceptanceKnown(true);
				}else{
					clearDeviceMarker(userId);
					setDeviceAcceptanceKnown(false);
				}
				setState(result.accepted?'accepted':'required');
			})
			.catch(exception=>{
				if(controller.signal.aborted)return;
				setError(exception instanceof Error?exception.message:'Terms acceptance status is temporarily unavailable.');
				setState('error');
			});
		return()=>controller.abort();
	},[eligible,userId,pathname,retryKey]);

	useEffect(()=>{
		const dialog=dialogRef.current;
		if(!dialog)return;
		if(visible&&!dialog.open)dialog.showModal();
		if(!visible&&dialog.open)dialog.close();
	},[visible]);

	async function acceptTerms(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		const acceptingUserId=userId;
		if(!checked||busy||!outstanding.length||!acceptingUserId)return;
		setBusy(true);
		setError('');
		try{
			const response=await fetch('/api/policy-consent',{
				method:'POST',
				headers:{'content-type':'application/json'},
				body:JSON.stringify({
					documents:outstanding.map(document=>({documentKey:document.documentKey,version:document.version})),
					accepted:true,
				}),
			});
			const result=await response.json() as ConsentResponse;
			if(!response.ok)throw new Error(result.error||'We could not save your acceptance. Please try again.');
			setOutstanding(result.outstanding||[]);
			if(result.accepted&&Array.isArray(result.documents)){
				saveDeviceMarker(acceptingUserId,result.documents);
				setDeviceAcceptanceKnown(true);
			}else{
				clearDeviceMarker(acceptingUserId);
				setDeviceAcceptanceKnown(false);
			}
			setState(result.accepted?'accepted':'required');
			setChecked(false);
		}catch(exception){
			setError(exception instanceof Error?exception.message:'We could not save your acceptance. Please try again.');
			setState('error');
		}finally{
			setBusy(false);
		}
	}

	return <>
		{!blockContent&&children}
		{(checkingSession||eligible&&state==='checking')&&<p className="policy-consent-checking" role="status">{checkingSession?'Restoring your authenticated session…':deviceAcceptanceKnown?'Verifying your saved legal acceptance…':'Checking your current legal acceptance…'}</p>}
		<dialog
		ref={dialogRef}
		className="policy-consent-dialog"
		aria-labelledby="policy-consent-title"
		aria-describedby="policy-consent-description"
		onCancel={event=>event.preventDefault()}
	>
		<div className="policy-consent-content">
			<p className="policy-consent-eyebrow">AUREVIA EXCHANGE</p>
			<h2 id="policy-consent-title">Review required legal documents</h2>
			<p id="policy-consent-description">Accept the outstanding current policy versions to continue. Previously accepted versions remain recorded in your account.</p>
			<div className="policy-consent-links">{outstanding.map(document=><Link key={`${document.documentKey}:${document.version}`} href={document.href}>{document.title} · v{document.version}</Link>)}<Link href="/legal-centre">Legal Centre · version history and acceptance status</Link></div>
			{state==='error'&&<p className="policy-consent-error" role="alert">{error}</p>}
			{state==='required'&&error&&<p className="policy-consent-error" role="alert">{error}</p>}
			{state==='error'?<button className="policy-consent-retry" type="button" onClick={()=>{setChecked(false);setState('checking');setRetryKey(value=>value+1)}}>Retry</button>:state==='checking'||checkingSession?null:<form onSubmit={acceptTerms}>
				{state==='required'&&<><label className="policy-consent-check">
					<input type="checkbox" checked={checked} onChange={event=>setChecked(event.target.checked)}/>
					<span>I have read and agree to the outstanding current versions listed above.</span>
				</label><button className="policy-consent-accept" type="submit" disabled={!checked||busy||!outstanding.length}>{busy?'Saving…':'Accept & Continue'}</button></>}
			</form>}
		</div>
		</dialog>
	</>;
}
