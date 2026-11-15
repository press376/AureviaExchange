'use client';

import {FormEvent,useEffect,useRef,useState,type ReactNode} from 'react';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {useSession} from 'next-auth/react';

type ConsentState='checking'|'required'|'accepted'|'error'|'inactive';
type ConsentDocument={documentKey:string;title:string;href:string;version:string;accepted:boolean;acceptedAt:string|null;content:string|null};
type ConsentResponse={accepted?:boolean;version?:string;error?:string;documents?:ConsentDocument[];outstanding?:ConsentDocument[]};
const policyPaths=new Set(['/terms','/privacy','/risk-disclosure','/aml-kyc','/deposit-withdrawal-policy','/platform-usage','/legal-centre']);

export default function PolicyConsentGate({children,initialUserId}:{children:ReactNode;initialUserId:string|null}){
	const pathname=usePathname();
	const {data:session,status}=useSession();
	const dialogRef=useRef<HTMLDialogElement>(null);
	const [state,setState]=useState<ConsentState>('inactive');
	const [checked,setChecked]=useState(false);
	const [outstanding,setOutstanding]=useState<ConsentDocument[]>([]);
	const [busy,setBusy]=useState(false);
	const [error,setError]=useState('');
	const [retryKey,setRetryKey]=useState(0);
	const userId=session?.user?.id;
	const eligible=status==='authenticated'&&(session?.user?.role==='USER'||session?.user?.role==='ADMIN')&&Boolean(userId)&&!policyPaths.has(pathname);
	const checkingSession=status==='loading'&&Boolean(initialUserId)&&!policyPaths.has(pathname);
	const visible=checkingSession||eligible&&(state==='checking'||state==='required'||state==='error');
	const blockContent=checkingSession||eligible&&state!=='accepted';

	useEffect(()=>{
		if(!eligible||!userId){
			setState('inactive');
			setChecked(false);
			setOutstanding([]);
			setError('');
			return;
		}
		const controller=new AbortController();
		setState('checking');
		setChecked(false);
		setOutstanding([]);
		setError('');
		void fetch('/api/policy-consent',{cache:'no-store',signal:controller.signal})
			.then(async response=>{
				const result=await response.json() as ConsentResponse;
				if(!response.ok)throw new Error(result.error||'Terms acceptance status is temporarily unavailable.');
				if(!Array.isArray(result.documents)||!Array.isArray(result.outstanding))throw new Error('Current legal document versions are unavailable.');
				setOutstanding(result.outstanding);
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
		if(!checked||busy||!outstanding.length)return;
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
			setState(result.accepted?'accepted':'required');
			setChecked(false);
			if(result.accepted)window.location.reload();
		}catch(exception){
			setError(exception instanceof Error?exception.message:'We could not save your acceptance. Please try again.');
			setState('error');
		}finally{
			setBusy(false);
		}
	}

	return <>
		{!blockContent&&children}
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
			{(checkingSession||state==='checking')&&<p role="status">Checking your current acceptance…</p>}
			<div className="policy-consent-links">{outstanding.map(document=><Link key={`${document.documentKey}:${document.version}`} href={document.href}>{document.title} · v{document.version}</Link>)}<Link href="/legal-centre">Legal Centre · version history and acceptance status</Link></div>
			{state==='error'&&<p className="policy-consent-error" role="alert">{error}</p>}
			{state==='required'&&error&&<p className="policy-consent-error" role="alert">{error}</p>}
			{state==='error'?<button className="policy-consent-retry" type="button" onClick={()=>{setState('checking');setRetryKey(value=>value+1)}}>Retry</button>:state==='checking'||checkingSession?null:<form onSubmit={acceptTerms}>
				{state==='required'&&<><label className="policy-consent-check">
					<input type="checkbox" checked={checked} onChange={event=>setChecked(event.target.checked)}/>
					<span>I have read and agree to the outstanding current versions listed above.</span>
				</label><button className="policy-consent-accept" type="submit" disabled={!checked||busy||!outstanding.length}>{busy?'Saving…':'Accept & Continue'}</button></>}
			</form>}
		</div>
		</dialog>
	</>;
}
