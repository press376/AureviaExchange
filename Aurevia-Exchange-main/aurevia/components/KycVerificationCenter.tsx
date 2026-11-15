'use client';

import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Country} from 'country-state-city';
import Link from 'next/link';
import {Camera,CheckCircle2,LoaderCircle,RefreshCw,ShieldCheck,Upload} from 'lucide-react';

type DocumentType='PASSPORT'|'NATIONAL_ID'|'DRIVING_LICENCE'|'RESIDENCE_PERMIT'|'OTHER';
type DocumentRequirement={type:DocumentType;label:string;sides:string[]};
type KycDocument={id:string;kind:string;documentSide:string|null;filename:string;mimeType:string;size:number;status:string;uploadedAt:string;reviewedAt:string|null;reviewNote:string|null};
type KycCheck={check:string;outcome:string;reason:string};
type KycVerification={id:string;status:string;documentCountry:string;documentType:string;submittedAt:string|null;reviewedAt:string|null;decisionReason:string|null;assessment:{riskLevel?:string;checks?:KycCheck[]}|null;documents:KycDocument[];events:{fromStatus:string|null;toStatus:string;action:string;reason:string|null;createdAt:string}[]};

const countries=Country.getAllCountries().sort((left,right)=>left.name.localeCompare(right.name));
const statusCopy:Record<string,string>={
	DRAFT:'Draft',
	SUBMITTED:'Submitted',
	PROCESSING:'Processing',
	PENDING_REVIEW:'Awaiting administrator review',
	NEEDS_REVIEW:'Additional administrator review',
	RESUBMISSION_REQUIRED:'Correction requested',
	APPROVED:'Approved',
	REJECTED:'Decision recorded',
	CANCELLED:'Superseded',
	EXPIRED:'Expired',
};

function stopTracks(stream:MediaStream|null){
	stream?.getTracks().forEach(track=>track.stop());
}

export default function KycVerificationCenter({currentTier,onUpdated}:{currentTier:number;onUpdated:()=>void}){
	const videoRef=useRef<HTMLVideoElement>(null);
	const streamRef=useRef<MediaStream|null>(null);
	const [requirements,setRequirements]=useState<DocumentRequirement[]>([]);
	const [verifications,setVerifications]=useState<KycVerification[]>([]);
	const [country,setCountry]=useState('');
	const [documentType,setDocumentType]=useState<DocumentType>('PASSPORT');
	const [front,setFront]=useState<File|null>(null);
	const [back,setBack]=useState<File|null>(null);
	const [selfie,setSelfie]=useState<File|null>(null);
	const [consent,setConsent]=useState(false);
	const [cameraActive,setCameraActive]=useState(false);
	const [loading,setLoading]=useState(true);
	const [submitting,setSubmitting]=useState(false);
	const [error,setError]=useState('');
	const [message,setMessage]=useState('');

	const selectedRequirement=useMemo(()=>requirements.find(item=>item.type===documentType),[documentType,requirements]);
	const latest=verifications[0]||null;
	const canSubmit=!submitting&&Boolean(country&&front&&selfie&&consent)&&(!selectedRequirement?.sides.includes('BACK')||Boolean(back))&&(!latest||['REJECTED','RESUBMISSION_REQUIRED','CANCELLED'].includes(latest.status));

	const load=useCallback(async()=>{
		setLoading(true);
		try{
			const response=await fetch('/api/kyc/verification',{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load your verification centre.');
			setRequirements(result.registry||[]);
			setVerifications(result.verifications||[]);
			setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load your verification centre.')}
		finally{setLoading(false)}
	},[]);

	useEffect(()=>{
		void load();
		const timer=setInterval(()=>{void load();onUpdated()},30_000);
		return()=>{clearInterval(timer);stopTracks(streamRef.current)};
	},[load,onUpdated]);

	async function startCamera(){
		setError('');
		try{
			if(!navigator.mediaDevices?.getUserMedia)throw new Error('Camera capture is not available in this browser.');
			stopTracks(streamRef.current);
			const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false});
			streamRef.current=stream;
			if(videoRef.current){videoRef.current.srcObject=stream;await videoRef.current.play()}
			setCameraActive(true);
		}catch(exception){setError(exception instanceof Error?exception.message:'Camera access was denied. Allow camera access or try again.')}
	}

	function captureSelfie(){
		const video=videoRef.current;
		if(!video||video.videoWidth<250||video.videoHeight<250){setError('Wait for the camera preview, then try the capture again.');return}
		const canvas=document.createElement('canvas');
		canvas.width=video.videoWidth;canvas.height=video.videoHeight;
		const context=canvas.getContext('2d');
		if(!context){setError('Camera capture is unavailable.');return}
		context.drawImage(video,0,0,canvas.width,canvas.height);
		canvas.toBlob(blob=>{
			if(!blob){setError('The selfie could not be captured. Try again.');return}
			setSelfie(new File([blob],'selfie.jpg',{type:'image/jpeg'}));
			setError('');setCameraActive(false);stopTracks(streamRef.current);streamRef.current=null;
		},'image/jpeg',0.92);
	}

	async function submit(event:React.FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(!canSubmit)return;
		setSubmitting(true);setError('');setMessage('');
		try{
			const form=new FormData();
			form.append('documentCountry',country);
			form.append('documentType',documentType);
			form.append('documentFront',front!);
			if(selectedRequirement?.sides.includes('BACK')&&back)form.append('documentBack',back);
			form.append('selfie',selfie!);
			form.append('consent','true');
			const response=await fetch('/api/kyc/verification',{method:'POST',body:form});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to submit your identity verification.');
			setFront(null);setBack(null);setSelfie(null);setConsent(false);
			setMessage('Your submission was received and is awaiting administrator review.');
			await load();onUpdated();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to submit your identity verification.')}
		finally{setSubmitting(false)}
	}

	return <section className="account-panel card mt-4 p-5" aria-labelledby="aurevia-verify-title">
		<div className="account-panel-title"><div><span className="account-kicker">AUREVIA VERIFY</span><h2 id="aurevia-verify-title" className="mt-1 text-xl font-semibold">First-party verification centre</h2><p className="account-panel-subtitle">Submit a private identity document and camera-captured selfie for administrator review.</p></div><ShieldCheck size={20} className="gold" aria-hidden="true"/></div>
		<div className="mt-4 grid gap-3 sm:grid-cols-3">
			<div className="rounded-lg border border-white/10 bg-black/20 p-3"><span className="text-xs muted">Current account tier</span><p className="mt-1 font-semibold">Tier {currentTier}</p></div>
			<div className="rounded-lg border border-white/10 bg-black/20 p-3"><span className="text-xs muted">Verification status</span><p className="mt-1 font-semibold">{latest?statusCopy[latest.status]||latest.status.replaceAll('_',' '):'Not started'}</p></div>
			<div className="rounded-lg border border-white/10 bg-black/20 p-3"><span className="text-xs muted">Automated assessment</span><p className="mt-1 font-semibold">Manual review required</p></div>
		</div>
		<p className="mt-3 text-sm leading-6 muted">Document image checks validate file integrity and dimensions only. OCR, government-source authentication, face comparison, duplicate detection, and presentation-attack/liveness analysis are not available. No automated check is represented as passed; an authorized administrator makes the decision.</p>
		{error&&<p className="mt-3 text-sm text-loss" role="alert">{error}</p>}
		{message&&<p className="mt-3 text-sm text-profit" role="status">{message}</p>}
		{loading?<p className="mt-4 muted"><LoaderCircle className="mr-2 inline animate-spin" size={16}/>Loading verification history…</p>:<>
			{latest&&<article className="mt-4 rounded-lg border border-white/10 p-4">
				<div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold">{latest.documentType.replaceAll('_',' ')} · {latest.documentCountry}</h3><p className="mt-1 text-sm muted">{statusCopy[latest.status]||latest.status.replaceAll('_',' ')} · {latest.submittedAt?`Submitted ${new Date(latest.submittedAt).toLocaleString()}`:'Not submitted'}{latest.reviewedAt?` · Reviewed ${new Date(latest.reviewedAt).toLocaleString()}`:''}</p></div><span className="status-pill">{latest.assessment?.riskLevel?.replaceAll('_',' ')||'Manual review'}</span></div>
				{latest.decisionReason&&<p className="mt-3 text-sm leading-6">{latest.decisionReason}</p>}
				{latest.status==='APPROVED'&&currentTier<3&&<p className="mt-3 text-sm muted">Your identity check is approved. Tier 3 also requires the residential address and proof of address already used by Aurevia’s tier policy. You can provide proof of address below after approval.</p>}
				{latest.documents.length>0&&<ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">{latest.documents.map(document=><li className="rounded border border-white/10 p-2" key={document.id}>{document.documentSide?.replaceAll('_',' ')||document.kind.replaceAll('_',' ')} · {document.status.replaceAll('_',' ')}<span className="block truncate text-xs muted">{document.filename}</span>{document.reviewNote&&<span className="mt-1 block text-xs">{document.reviewNote}</span>}</li>)}</ul>}
				<details className="mt-3"><summary className="cursor-pointer text-sm gold">Assessment checks</summary><ul className="mt-2 space-y-2 text-xs">{latest.assessment?.checks?.map(check=><li key={check.check}><b>{check.check.replaceAll('_',' ')} · {check.outcome.replaceAll('_',' ')}</b><span className="block muted">{check.reason}</span></li>)}</ul></details>
			</article>}
			{latest&&['PENDING_REVIEW','PROCESSING','SUBMITTED','NEEDS_REVIEW'].includes(latest.status)?<p className="mt-4 text-sm muted">Your case is awaiting review. You’ll receive an in-app notification and email when its status changes.</p>:<form className="mt-5 space-y-4" onSubmit={submit}>
				<h3 className="font-semibold">{latest?.status==='RESUBMISSION_REQUIRED'?'Submit corrected evidence':'Start a verification submission'}</h3>
				<div className="grid gap-3 sm:grid-cols-2">
					<label className="account-label">Document-issuing country<select className="input" value={country} onChange={event=>setCountry(event.target.value)} required><option value="">Select a country</option>{countries.map(item=><option key={item.isoCode} value={item.isoCode}>{item.name}</option>)}</select></label>
					<label className="account-label">Document type<select className="input" value={documentType} onChange={event=>{setDocumentType(event.target.value as DocumentType);setBack(null)}}>{requirements.map(item=><option key={item.type} value={item.type}>{item.label}</option>)}</select></label>
				</div>
				<div className="grid gap-3 sm:grid-cols-2">
					<label className="account-label">Document front<input className="input" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" capture="environment" onChange={event=>setFront(event.target.files?.[0]||null)} required/><small className="muted">JPEG, PNG or WebP · maximum 8 MB</small></label>
					{selectedRequirement?.sides.includes('BACK')&&<label className="account-label">Document back<input className="input" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" capture="environment" onChange={event=>setBack(event.target.files?.[0]||null)} required/><small className="muted">JPEG, PNG or WebP · maximum 8 MB</small></label>}
				</div>
				<div className="rounded-lg border border-white/10 p-3">
					<h4 className="text-sm font-semibold">Camera-captured selfie</h4>
					<p className="mt-1 text-xs leading-5 muted">Use a live camera capture; an uploaded ID portrait is not accepted as a selfie. Face matching and liveness detection are unavailable, so the image requires manual review and is not proof of liveness.</p>
					{cameraActive&&<div className="mt-3"><video ref={videoRef} className="max-h-72 w-full rounded-lg bg-black object-contain" autoPlay playsInline muted aria-label="Live selfie camera preview"/><div className="mt-2 flex gap-2"><button className="btn min-h-11 bg-gold text-black" type="button" onClick={captureSelfie}><Camera size={16}/>Capture selfie</button><button className="btn min-h-11 bg-white/10" type="button" onClick={()=>{setCameraActive(false);stopTracks(streamRef.current);streamRef.current=null}}>Cancel</button></div></div>}
					{selfie?<div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm"><span>{selfie.name} · {(selfie.size/1024).toFixed(0)} KB</span><button className="text-link" type="button" onClick={()=>{setSelfie(null);void startCamera()}}><RefreshCw size={14}/> Retake</button></div>:!cameraActive&&<button className="btn mt-3 min-h-11 bg-white/10" type="button" onClick={()=>void startCamera()}><Camera size={16}/>Open camera</button>}
				</div>
				<label className="flex items-start gap-2 text-sm leading-6 muted"><input className="mt-1" type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/><span>I consent to Aurevia securely storing this identity evidence and making it available to authorized reviewers for identity verification. See the <Link className="text-link" href="/privacy">privacy overview</Link>.</span></label>
				<div className="flex flex-wrap items-center gap-3"><button className="btn min-h-11 bg-gold px-4 text-black disabled:opacity-50" type="submit" disabled={!canSubmit}>{submitting?<><LoaderCircle size={16} className="animate-spin"/>Submitting securely…</>:<><Upload size={16}/>Submit for review</>}</button>{submitting&&<span className="text-xs muted" role="status">Uploading and validating your files…</span>}</div>
			</form>}
			{verifications.length>1&&<details className="mt-5"><summary className="cursor-pointer text-sm gold">Previous verification cases ({verifications.length-1})</summary><ul className="mt-2 divide-y divide-white/10">{verifications.slice(1).map(item=><li className="py-2 text-sm" key={item.id}>{statusCopy[item.status]||item.status.replaceAll('_',' ')} · {item.submittedAt?new Date(item.submittedAt).toLocaleDateString():'Draft'}{item.decisionReason&&<span className="block text-xs muted">{item.decisionReason}</span>}</li>)}</ul></details>}
		</>}
		{latest?.status==='APPROVED'&&currentTier<3&&<p className="mt-4 text-sm"><Link className="text-link" href="/settings#profile">Update profile address</Link> · <Link className="text-link" href="/tier">Review Tier 3 requirements</Link></p>}
		{latest?.status==='APPROVED'&&currentTier>=3&&<p className="mt-4 text-sm text-profit"><CheckCircle2 className="mr-2 inline" size={16}/>Approved and upgraded to Tier 3.</p>}
	</section>;
}
