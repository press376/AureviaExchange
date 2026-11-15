'use client';

import {useCallback,useEffect,useMemo,useState} from 'react';
import {CheckCircle2,ChevronLeft,ChevronRight,LoaderCircle,RefreshCw,ShieldAlert} from 'lucide-react';

type KycDocument={id:string;kind:string;documentSide:string|null;filename:string;mimeType:string;size:number;status:string;uploadedAt:string;reviewedAt:string|null;reviewNote:string|null};
type KycCheck={check:string;outcome:string;reason:string};
type Reviewer={id:string;name:string|null;email:string};
type CaseSummary={
	id:string;status:string;documentCountry:string;documentType:string;submittedAt:string|null;reviewedAt:string|null;reviewedById:string|null;assignedToId:string|null;assessment:{engine?:string|null;riskLevel?:string;checks?:KycCheck[]}|null;
	user:{id:string;name:string|null;email:string;accountMode:'DEMO'|'REAL';approvedTier:number;kycStatus:string};
	documents:KycDocument[];reviewedBy:Reviewer|null;assignedTo:Reviewer|null;
};
type CaseDetail=CaseSummary&{
	registryVersion:string;consentVersion:string;consentAt:string;processedAt:string|null;legalHoldAt:string|null;legalHoldReason:string|null;evidencePurgeAttempts:number;evidencePurgeNextAttemptAt:string|null;evidencePurgeErrorCode:string|null;decisionReason:string|null;internalNote:string|null;isLatest:boolean;documentRequirements:string[];
	user:CaseSummary['user']&{firstName:string|null;lastName:string|null;country:string|null;status:string;createdAt:string;kyc:{legalName:string|null;dob:string|null;address:string|null;addressLine1:string|null;addressLine2:string|null;city:string|null;stateProvince:string|null;postalCode:string|null;addressCountry:string|null}|null;kycVerifications:{id:string;status:string;submittedAt:string|null;reviewedAt:string|null;decisionReason:string|null}[]};
	events:{actorId:string|null;fromStatus:string|null;toStatus:string;action:string;reason:string|null;metadata:unknown;createdAt:string}[];
};
type QueueStats={total:number;pendingReview:number;processing:number;needsReview:number;approved:number;rejected:number;resubmissionRequired:number;highRisk:number;averageReviewHours:number|null};
type QueueResponse={items:CaseSummary[];total:number;page:number;pageSize:number;totalPages:number;stats:QueueStats;trends:{date:string;count:number}[];workload:{reviewer:Reviewer|null;count:number}[]};
type RetentionArchiveItem={
	verificationId:string;decisionStatus:string;decisionCategory:string;submittedAt:string|null;decidedAt:string;evidencePurgedAt:string;evidencePurgeOutcome:string;retainUntil:string;legalHoldAt:string|null;legalHoldReason:string|null;retentionPurgeAttempts:number;retentionPurgeNextAttemptAt:string|null;retentionPurgeErrorCode:string|null;
	events:{actorReference:string|null;action:string;fromStatus:string|null;toStatus:string|null;reason:string|null;createdAt:string}[];
};
type RetentionArchiveResponse={items:RetentionArchiveItem[];total:number;page:number;pageSize:number;totalPages:number};
type Decision='ASSIGN_TO_ME'|'APPROVE'|'REJECT'|'RESUBMISSION_REQUIRED'|'ESCALATE';

const documentTypeLabels:Record<string,string>={PASSPORT:'International passport',NATIONAL_ID:'National identity card',DRIVING_LICENCE:'Driving licence',RESIDENCE_PERMIT:'Residence permit',OTHER:'Other identity document'};
const statsLabels:[keyof QueueStats,string][]=[
	['total','Applications'],['pendingReview','Pending review'],['processing','Processing'],['approved','Approved'],['rejected','Rejected'],['resubmissionRequired','Resubmission required'],['highRisk','High risk'],
];

export default function AdminKycCasesPanel(){
	const [queue,setQueue]=useState<QueueResponse|null>(null);
	const [retentionArchive,setRetentionArchive]=useState<RetentionArchiveResponse|null>(null);
	const [detail,setDetail]=useState<CaseDetail|null>(null);
	const [search,setSearch]=useState('');
	const [status,setStatus]=useState('');
	const [country,setCountry]=useState('');
	const [documentType,setDocumentType]=useState('');
	const [risk,setRisk]=useState('');
	const [reviewer,setReviewer]=useState('');
	const [dateFrom,setDateFrom]=useState('');
	const [dateTo,setDateTo]=useState('');
	const [archiveSearch,setArchiveSearch]=useState('');
	const [archivePage,setArchivePage]=useState(1);
	const [sort,setSort]=useState<'NEWEST'|'OLDEST'>('NEWEST');
	const [page,setPage]=useState(1);
	const [selectedDocumentIds,setSelectedDocumentIds]=useState<string[]>([]);
	const [documentUrls,setDocumentUrls]=useState<Record<string,string>>({});
	const [reason,setReason]=useState('');
	const [internalNote,setInternalNote]=useState('');
	const [retentionReason,setRetentionReason]=useState('');
	const [confirmed,setConfirmed]=useState(false);
	const [loading,setLoading]=useState(true);
	const [busy,setBusy]=useState(false);
	const [archiveLoading,setArchiveLoading]=useState(true);
	const [archiveBusyId,setArchiveBusyId]=useState('');
	const [error,setError]=useState('');
	const [message,setMessage]=useState('');

	const queueQuery=useMemo(()=>{
		const params=new URLSearchParams({page:String(page),sort});
		if(search.trim())params.set('search',search.trim());
		if(status)params.set('status',status);
		if(country.trim())params.set('country',country.trim());
		if(documentType)params.set('documentType',documentType);
		if(risk)params.set('risk',risk);
		if(reviewer.trim())params.set('reviewer',reviewer.trim());
		if(dateFrom)params.set('dateFrom',dateFrom);
		if(dateTo)params.set('dateTo',dateTo);
		return params.toString();
	},[page,sort,search,status,country,documentType,risk,reviewer,dateFrom,dateTo]);

	const loadQueue=useCallback(async()=>{
		setLoading(true);
		try{
			const response=await fetch(`/api/admin/kyc/verifications?${queueQuery}`,{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load the KYC review queue.');
			setQueue(result);setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load the KYC review queue.')}
		finally{setLoading(false)}
	},[queueQuery]);

	useEffect(()=>{void loadQueue()},[loadQueue]);

	const loadRetentionArchive=useCallback(async()=>{
		setArchiveLoading(true);
		try{
			const params=new URLSearchParams({page:String(archivePage)});
			if(archiveSearch.trim())params.set('search',archiveSearch.trim());
			const response=await fetch(`/api/admin/kyc/retention?${params}`,{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load retained KYC records.');
			setRetentionArchive(result);
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load retained KYC records.')}
		finally{setArchiveLoading(false)}
	},[archivePage,archiveSearch]);

	useEffect(()=>{void loadRetentionArchive()},[loadRetentionArchive]);

	const loadCase=useCallback(async(id:string)=>{
		setDetail(null);setDocumentUrls({});setSelectedDocumentIds([]);setReason('');setInternalNote('');setRetentionReason('');setConfirmed(false);
		try{
			const response=await fetch(`/api/admin/kyc/verifications/${encodeURIComponent(id)}`,{cache:'no-store'});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load this verification case.');
			setDetail(result);
			const urls=await Promise.all(result.documents.map(async(document:KycDocument)=>{
				const fileResponse=await fetch(`/api/admin/kyc/documents/${encodeURIComponent(document.id)}`,{cache:'no-store'});
				const fileResult=await fileResponse.json();
				if(!fileResponse.ok)throw new Error(fileResult.error||`Unable to preview ${document.documentSide||document.kind}.`);
				return [document.id,fileResult.url] as const;
			}));
			setDocumentUrls(Object.fromEntries(urls));
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load this verification case.')}
	},[]);

	async function updateLegalHold(verificationId:string,action:'PLACE_HOLD'|'UPDATE_HOLD'|'RELEASE_HOLD'){
		if(busy||retentionReason.trim().length<3)return;
		setBusy(true);setError('');setMessage('');
		try{
			const response=await fetch('/api/admin/kyc/retention',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({verificationId,action,reason:retentionReason.trim()})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to update the legal hold.');
			setMessage(result.alreadyApplied?'The legal-hold state was already current.':'The legal-hold state was updated and recorded.');
			if(detail?.id===verificationId)setDetail(current=>current?{...current,legalHoldAt:result.legalHoldAt,legalHoldReason:result.legalHoldAt?retentionReason.trim():null}:current);
			setRetentionReason('');
			await loadRetentionArchive();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update the legal hold.')}
		finally{setBusy(false)}
	}

	async function updateArchivedLegalHold(item:RetentionArchiveItem,action:'PLACE_HOLD'|'UPDATE_HOLD'|'RELEASE_HOLD'){
		if(archiveBusyId||retentionReason.trim().length<3)return;
		setArchiveBusyId(item.verificationId);setError('');setMessage('');
		try{
			const response=await fetch('/api/admin/kyc/retention',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({verificationId:item.verificationId,action,reason:retentionReason.trim()})});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to update the legal hold.');
			setMessage(result.alreadyApplied?'The legal-hold state was already current.':'The legal-hold state was updated and recorded.');
			setRetentionReason('');
			await loadRetentionArchive();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update the legal hold.')}
		finally{setArchiveBusyId('')}
	}

	async function decide(decision:Decision){
		if(!detail||busy||(!confirmed&&decision!=='ASSIGN_TO_ME'))return;
		if((decision==='REJECT'||decision==='RESUBMISSION_REQUIRED')&&reason.trim().length<3)return;
		if(decision==='RESUBMISSION_REQUIRED'&&!selectedDocumentIds.length)return;
		if(decision==='ESCALATE'&&internalNote.trim().length<3)return;
		setBusy(true);setError('');setMessage('');
		try{
			const payload={
				decision,confirmed:decision==='ASSIGN_TO_ME'?true:confirmed,
				...(decision==='APPROVE'?{reason:reason.trim()||undefined,internalNote:internalNote.trim()||undefined}:{}),
				...(decision==='REJECT'||decision==='RESUBMISSION_REQUIRED'?{reason:reason.trim(),internalNote:internalNote.trim()||undefined}:{}),
				...(decision==='RESUBMISSION_REQUIRED'?{documentIds:selectedDocumentIds}:{}),
				...(decision==='ESCALATE'?{internalNote:internalNote.trim()}:{}),
			};
			const response=await fetch(`/api/admin/kyc/verifications/${encodeURIComponent(detail.id)}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to save the case decision.');
			setMessage(result.tier3Upgraded?'Case approved and account automatically upgraded to Tier 3.':`Case status updated to ${result.status.replaceAll('_',' ').toLowerCase()}.`);
			setDetail(null);await loadQueue();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to save the case decision.')}
		finally{setBusy(false)}
	}

	const peakTrend=Math.max(1,...(queue?.trends.map(item=>item.count)||[]));
	const checks=detail?.assessment?.checks||[];

	return <section className="card mb-5 p-4 sm:p-5" aria-labelledby="admin-aurevia-verify-title">
		<header className="flex flex-wrap items-end justify-between gap-3"><div><span className="account-kicker">AUREVIA VERIFY</span><h2 id="admin-aurevia-verify-title" className="mt-1 text-xl font-bold">Verification operations centre</h2><p className="mt-1 text-sm muted">First-party identity cases, evidence, assessment availability, and administrator decisions.</p></div><button className="btn min-h-11 bg-white/5" type="button" onClick={()=>void loadQueue()} disabled={loading}>{loading?<LoaderCircle size={16} className="animate-spin"/>:<RefreshCw size={16}/>}Refresh</button></header>
		{error&&<p className="mt-3 text-sm text-loss" role="alert">{error}</p>}{message&&<p className="mt-3 text-sm text-profit" role="status">{message}</p>}
		{queue&&<><div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{statsLabels.map(([key,label])=><div className="rounded-lg border border-white/10 bg-black/20 p-3" key={key}><p className="text-xs muted">{label}</p><p className="mt-1 text-xl font-semibold">{queue.stats[key]??0}</p></div>)}<div className="rounded-lg border border-white/10 bg-black/20 p-3"><p className="text-xs muted">Average review time</p><p className="mt-1 text-xl font-semibold">{queue.stats.averageReviewHours===null?'—':`${queue.stats.averageReviewHours} h`}</p></div></div>
			<div className="mt-4 grid gap-3 lg:grid-cols-2">
				<div className="rounded-lg border border-white/10 p-3"><h3 className="text-sm font-semibold">Applications · last 30 days</h3><div className="mt-3 flex h-20 items-end gap-1" aria-label="Daily submitted application trend">{queue.trends.map(item=><div className="min-w-1 flex-1 rounded-t bg-gold/70" key={item.date} title={`${item.date}: ${item.count}`} style={{height:`${Math.max(4,item.count/peakTrend*100)}%`}}/>)}</div><p className="mt-2 text-xs muted">{queue.trends.reduce((sum,item)=>sum+item.count,0)} submitted</p></div>
				<div className="rounded-lg border border-white/10 p-3"><h3 className="text-sm font-semibold">Administrator workload</h3>{queue.workload.length?<ul className="mt-2 divide-y divide-white/10 text-sm">{queue.workload.map(item=><li className="flex justify-between gap-2 py-2" key={item.reviewer?.id}>{item.reviewer?.name||item.reviewer?.email||'Unassigned'}<span>{item.count}</span></li>)}</ul>:<p className="mt-2 text-sm muted">No assigned cases.</p>}</div>
			</div>
			<div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
				<label className="account-label text-xs">Search customer, account or case<input className="input mt-1 min-h-10" value={search} onChange={event=>{setSearch(event.target.value);setPage(1)}} placeholder="Name, email, user ID, case ID"/></label>
				<label className="account-label text-xs">Status<select className="input mt-1 min-h-10" value={status} onChange={event=>{setStatus(event.target.value);setPage(1)}}><option value="">All statuses</option>{['SUBMITTED','PROCESSING','PENDING_REVIEW','NEEDS_REVIEW','RESUBMISSION_REQUIRED','APPROVED','REJECTED','CANCELLED','EXPIRED'].map(item=><option key={item} value={item}>{item.replaceAll('_',' ')}</option>)}</select></label>
				<label className="account-label text-xs">Document type<select className="input mt-1 min-h-10" value={documentType} onChange={event=>{setDocumentType(event.target.value);setPage(1)}}><option value="">All types</option>{Object.entries(documentTypeLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
				<label className="account-label text-xs">Risk classification<select className="input mt-1 min-h-10" value={risk} onChange={event=>{setRisk(event.target.value);setPage(1)}}><option value="">All classifications</option>{['LOW','MEDIUM','HIGH','MANUAL_REVIEW_REQUIRED'].map(item=><option key={item} value={item}>{item.replaceAll('_',' ')}</option>)}</select></label>
				<label className="account-label text-xs">Country code<input className="input mt-1 min-h-10" maxLength={2} value={country} onChange={event=>{setCountry(event.target.value.toUpperCase());setPage(1)}} placeholder="US"/></label>
				<label className="account-label text-xs">Reviewer<input className="input mt-1 min-h-10" value={reviewer} onChange={event=>{setReviewer(event.target.value);setPage(1)}} placeholder="Admin name or email"/></label>
				<label className="account-label text-xs">Submitted from<input className="input mt-1 min-h-10" type="date" value={dateFrom} onChange={event=>{setDateFrom(event.target.value);setPage(1)}}/></label>
				<label className="account-label text-xs">Submitted through<input className="input mt-1 min-h-10" type="date" value={dateTo} onChange={event=>{setDateTo(event.target.value);setPage(1)}}/></label>
				<label className="account-label text-xs">Sort by submission<select className="input mt-1 min-h-10" value={sort} onChange={event=>setSort(event.target.value as 'NEWEST'|'OLDEST')}><option value="NEWEST">Newest first</option><option value="OLDEST">Oldest first</option></select></label>
			</div>
			{loading&&!queue.items.length?<p className="mt-4 muted">Loading review queue…</p>:queue.items.length?<div className="mt-4 divide-y divide-white/10">{queue.items.map(item=><article className="flex flex-wrap items-center justify-between gap-3 py-3" key={item.id}>
				<div className="min-w-0"><p className="break-all font-semibold">{item.user.name||item.user.email}</p><p className="mt-1 break-all text-xs muted">{item.user.email} · {item.user.accountMode} · Tier {item.user.approvedTier} · {item.documentCountry} · {documentTypeLabels[item.documentType]||item.documentType}</p><p className="mt-1 text-xs muted">{item.status.replaceAll('_',' ')} · {item.submittedAt?new Date(item.submittedAt).toLocaleString():'Not submitted'} · {item.documents.length} evidence files</p></div>
				<div className="flex items-center gap-2"><span className="status-pill">{item.assessment?.riskLevel?.replaceAll('_',' ')||'Manual review'}</span><span className="text-xs muted">{item.assignedTo?`Assigned: ${item.assignedTo.name||item.assignedTo.email}`:'Unassigned'}</span><button className="btn min-h-10 bg-gold px-3 text-black" type="button" onClick={()=>void loadCase(item.id)}>Open case</button></div>
			</article>)}</div>:<p className="mt-4 muted">No verification cases match these filters.</p>}
			<div className="mt-3 flex items-center justify-between text-sm"><span className="muted">{queue.total} cases · Page {queue.page} of {Math.max(queue.totalPages,1)}</span><div className="flex gap-2"><button className="btn min-h-10 bg-white/5" type="button" aria-label="Previous page" disabled={page<=1||loading} onClick={()=>setPage(value=>Math.max(1,value-1))}><ChevronLeft size={16}/></button><button className="btn min-h-10 bg-white/5" type="button" aria-label="Next page" disabled={page>=queue.totalPages||loading} onClick={()=>setPage(value=>value+1)}><ChevronRight size={16}/></button></div></div>
		</>}
		<section className="mt-6 border-t border-white/10 pt-5" aria-labelledby="kyc-retention-archive-title">
			<div className="flex flex-wrap items-end justify-between gap-3"><div><h3 id="kyc-retention-archive-title" className="text-lg font-bold">Pseudonymized retention archive</h3><p className="mt-1 text-sm muted">Historical decision and audit metadata only; identity images and personal profile data are not retained here.</p></div><label className="account-label text-xs">Search case ID<input className="input mt-1 min-h-10" value={archiveSearch} onChange={event=>{setArchiveSearch(event.target.value);setArchivePage(1)}} maxLength={128} placeholder="Verification case ID"/></label></div>
			{archiveLoading?<p className="mt-3 text-sm muted">Loading retained records…</p>:retentionArchive?.items.length?<div className="mt-3 divide-y divide-white/10">{retentionArchive.items.map(item=><article className="py-3" key={item.verificationId}>
				<div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="break-all font-semibold">{item.verificationId}</p><p className="mt-1 text-xs muted">{item.decisionCategory.replaceAll('_',' ')} · {item.decisionStatus.replaceAll('_',' ')} · decided {new Date(item.decidedAt).toLocaleString()}</p><p className="mt-1 text-xs muted">Evidence purged {new Date(item.evidencePurgedAt).toLocaleString()} · metadata retained until {new Date(item.retainUntil).toLocaleDateString()} · {item.evidencePurgeOutcome.replaceAll('_',' ').toLowerCase()}</p>{item.retentionPurgeAttempts>0&&<p className="mt-1 text-xs muted">Metadata purge attempts: {item.retentionPurgeAttempts}{item.retentionPurgeNextAttemptAt?` · retry after ${new Date(item.retentionPurgeNextAttemptAt).toLocaleString()}`:''}{item.retentionPurgeErrorCode?` · last outcome ${item.retentionPurgeErrorCode}`:''}</p>}{item.legalHoldAt&&<p className="mt-1 text-sm text-amber-200">Legal hold since {new Date(item.legalHoldAt).toLocaleString()}: {item.legalHoldReason}</p>}</div><span className="status-pill">{item.legalHoldAt?'Legal hold':'Retention active'}</span></div>
				<details className="mt-2 text-sm"><summary className="cursor-pointer gold">Recent pseudonymized audit events (up to 25)</summary><ul className="mt-2 divide-y divide-white/10">{item.events.map((event,index)=><li className="py-2" key={`${event.createdAt}-${index}`}>{event.action.replaceAll('_',' ')} · {new Date(event.createdAt).toLocaleString()}{event.fromStatus&&event.toStatus&&<span> · {event.fromStatus} → {event.toStatus}</span>}{event.reason&&<span className="block text-xs muted">{event.reason}</span>}{event.actorReference&&<span className="block break-all text-xs muted">Actor reference: {event.actorReference}</span>}</li>)}</ul></details>
				<label className="account-label mt-2 block text-xs">Document reason for legal-hold change<textarea className="input mt-1 min-h-16" maxLength={1000} value={retentionReason} onChange={event=>setRetentionReason(event.target.value)} placeholder="Required for placing or releasing a hold"/></label>
				<div className="mt-2 flex gap-2">{item.legalHoldAt?<><button className="btn min-h-10 bg-white/10 px-3 disabled:opacity-50" type="button" disabled={!!archiveBusyId||retentionReason.trim().length<3} onClick={()=>void updateArchivedLegalHold(item,'UPDATE_HOLD')}>Update hold details</button><button className="btn min-h-10 bg-white/10 px-3 disabled:opacity-50" type="button" disabled={!!archiveBusyId||retentionReason.trim().length<3} onClick={()=>void updateArchivedLegalHold(item,'RELEASE_HOLD')}>Release legal hold</button></>:<button className="btn min-h-10 bg-white/10 px-3 disabled:opacity-50" type="button" disabled={!!archiveBusyId||retentionReason.trim().length<3} onClick={()=>void updateArchivedLegalHold(item,'PLACE_HOLD')}>{archiveBusyId===item.verificationId?'Saving…':'Place legal hold'}</button>}</div>
			</article>)}</div>:<p className="mt-3 text-sm muted">{archiveSearch?'No retained record matches this case ID.':'No pseudonymized records are available yet.'}</p>}
			{retentionArchive&&retentionArchive.totalPages>1&&<div className="mt-3 flex items-center justify-between text-sm"><span className="muted">{retentionArchive.total} retained records · Page {retentionArchive.page} of {retentionArchive.totalPages}</span><div className="flex gap-2"><button className="btn min-h-10 bg-white/5" type="button" aria-label="Previous archive page" disabled={archivePage<=1||archiveLoading} onClick={()=>setArchivePage(value=>Math.max(1,value-1))}><ChevronLeft size={16}/></button><button className="btn min-h-10 bg-white/5" type="button" aria-label="Next archive page" disabled={archivePage>=retentionArchive.totalPages||archiveLoading} onClick={()=>setArchivePage(value=>value+1)}><ChevronRight size={16}/></button></div></div>}
		</section>
		{detail&&<article className="mt-6 border-t border-white/10 pt-5">
			<header className="flex flex-wrap items-start justify-between gap-3"><div><span className="account-kicker">CASE {detail.id}</span><h3 className="mt-1 text-lg font-bold">{detail.user.name||detail.user.email}</h3><p className="mt-1 text-sm muted">{detail.user.email} · {detail.user.id} · {detail.user.accountMode} · Tier {detail.user.approvedTier} · account {detail.user.status}</p><p className="mt-1 text-sm muted">{documentTypeLabels[detail.documentType]||detail.documentType} · {detail.documentCountry} · {detail.status.replaceAll('_',' ')} · {detail.assignedTo?`Assigned to ${detail.assignedTo.name||detail.assignedTo.email}`:'Unassigned'}</p></div><div className="flex gap-2">{['PENDING_REVIEW','NEEDS_REVIEW'].includes(detail.status)&&detail.isLatest&&<button className="btn min-h-10 bg-white/10" type="button" disabled={busy} onClick={()=>void decide('ASSIGN_TO_ME')}>{detail.assignedToId?'Reassign to me':'Assign to me'}</button>}<button className="btn min-h-10 bg-white/5" type="button" onClick={()=>setDetail(null)}>Close</button></div></header>
			<section className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3"><h4 className="font-semibold">Evidence legal hold</h4>{detail.legalHoldAt?<p className="mt-1 text-sm text-amber-200">Held since {new Date(detail.legalHoldAt).toLocaleString()}: {detail.legalHoldReason}</p>:<p className="mt-1 text-sm muted">No legal hold is active. Holds prevent automated evidence and metadata purging while active. Holds on archived records cannot restore evidence already purged.</p>}{detail.evidencePurgeAttempts>0&&<p className="mt-1 text-xs muted">Evidence purge attempts: {detail.evidencePurgeAttempts}{detail.evidencePurgeNextAttemptAt?` · retry after ${new Date(detail.evidencePurgeNextAttemptAt).toLocaleString()}`:''}{detail.evidencePurgeErrorCode?` · last outcome ${detail.evidencePurgeErrorCode}`:''}</p>}<label className="account-label mt-2 block text-xs">Document reason for {detail.legalHoldAt?'updating or releasing':'placing'} this hold<textarea className="input mt-1 min-h-16" maxLength={1000} value={retentionReason} onChange={event=>setRetentionReason(event.target.value)} placeholder="Required for the audit record"/></label>{detail.legalHoldAt?<div className="mt-2 flex gap-2"><button className="btn min-h-10 bg-white/10 px-3 disabled:opacity-50" type="button" disabled={busy||retentionReason.trim().length<3} onClick={()=>void updateLegalHold(detail.id,'UPDATE_HOLD')}>Update hold details</button><button className="btn min-h-10 bg-white/10 px-3 disabled:opacity-50" type="button" disabled={busy||retentionReason.trim().length<3} onClick={()=>void updateLegalHold(detail.id,'RELEASE_HOLD')}>Release legal hold</button></div>:<button className="btn mt-2 min-h-10 bg-white/10 px-3 disabled:opacity-50" type="button" disabled={busy||retentionReason.trim().length<3} onClick={()=>void updateLegalHold(detail.id,'PLACE_HOLD')}>{busy?'Saving…':'Place legal hold'}</button>}</section>
			{!detail.isLatest&&<p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200" role="alert">A newer non-cancelled case exists. This case cannot be decided.</p>}
			<div className="mt-4 grid gap-3 lg:grid-cols-2">
				<section className="rounded-lg border border-white/10 p-3"><h4 className="font-semibold">Customer and profile</h4><dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-xs muted">Registered</dt><dd>{new Date(detail.user.createdAt).toLocaleString()}</dd></div><div><dt className="text-xs muted">Profile country</dt><dd>{detail.user.country||'Not provided'}</dd></div><div><dt className="text-xs muted">KYC status</dt><dd>{detail.user.kycStatus.replaceAll('_',' ')}</dd></div><div><dt className="text-xs muted">Consent recorded</dt><dd>{new Date(detail.consentAt).toLocaleString()} · {detail.consentVersion}</dd></div><div className="sm:col-span-2"><dt className="text-xs muted">Residential address</dt><dd>{[detail.user.kyc?.addressLine1,detail.user.kyc?.addressLine2,detail.user.kyc?.city,detail.user.kyc?.stateProvince,detail.user.kyc?.postalCode,detail.user.kyc?.addressCountry].filter(Boolean).join(', ')||detail.user.kyc?.address||'Not provided'}</dd></div></dl></section>
				<section className="rounded-lg border border-white/10 p-3"><h4 className="font-semibold">Assessment</h4><p className="mt-1 text-sm">Risk classification: <b>{detail.assessment?.riskLevel?.replaceAll('_',' ')||'Manual review required'}</b></p><p className="mt-1 text-xs muted">Engine: {detail.assessment?.engine||'Unavailable'} · Rule registry: {detail.registryVersion}</p>{checks.length?<ul className="mt-2 space-y-2">{checks.map(check=><li className="rounded bg-black/20 p-2 text-sm" key={check.check}><b>{check.check.replaceAll('_',' ')} · {check.outcome.replaceAll('_',' ')}</b><p className="mt-1 text-xs muted">{check.reason}</p></li>)}</ul>:<p className="mt-2 text-sm muted">No automated checks are available.</p>}</section>
			</div>
			<section className="mt-3 rounded-lg border border-white/10 p-3"><h4 className="font-semibold">Evidence · ID portrait and applicant selfie</h4><p className="mt-1 text-xs muted">Short-lived private review links. No automated face comparison or liveness result is available.</p><div className="mt-3 grid gap-3 md:grid-cols-2">{detail.documents.map(document=><div className="rounded-lg border border-white/10 p-2" key={document.id}><p className="text-sm font-semibold">{document.documentSide||document.kind.replaceAll('_',' ')} · {document.status.replaceAll('_',' ')}</p><p className="truncate text-xs muted">{document.filename} · {document.mimeType} · {(document.size/1024).toFixed(0)} KB</p>{documentUrls[document.id]?<><iframe className="mt-2 h-64 w-full rounded bg-black" title={`Private ${document.documentSide||document.kind} evidence`} src={documentUrls[document.id]} loading="lazy" referrerPolicy="no-referrer"/><a className="text-link text-xs" href={documentUrls[document.id]} target="_blank" rel="noreferrer">Open private file in a new tab</a></>:<p className="mt-2 text-xs muted"><LoaderCircle className="mr-1 inline animate-spin" size={12}/>Generating short-lived review link…</p>}{document.reviewNote&&<p className="mt-1 text-xs">{document.reviewNote}</p>}</div>)}</div></section>
			{detail.user.kycVerifications.length>0&&<details className="mt-3 rounded-lg border border-white/10 p-3"><summary className="cursor-pointer text-sm gold">Previous cases</summary><ul className="mt-2 divide-y divide-white/10 text-sm">{detail.user.kycVerifications.map(item=><li className="py-2" key={item.id}>{item.id} · {item.status.replaceAll('_',' ')} · {item.submittedAt?new Date(item.submittedAt).toLocaleString():'Not submitted'}{item.decisionReason&&<span className="block text-xs muted">{item.decisionReason}</span>}</li>)}</ul></details>}
			<details className="mt-3 rounded-lg border border-white/10 p-3"><summary className="cursor-pointer text-sm gold">State and decision history</summary><ul className="mt-2 divide-y divide-white/10 text-sm">{detail.events.map((event,index)=><li className="py-2" key={`${event.createdAt}-${index}`}>{event.fromStatus||'New'} → {event.toStatus} · {event.action} · {new Date(event.createdAt).toLocaleString()}{event.reason&&<span className="block text-xs muted">{event.reason}</span>}</li>)}</ul></details>
			{['PENDING_REVIEW','NEEDS_REVIEW'].includes(detail.status)&&detail.isLatest&&<section className="mt-4 rounded-lg border border-gold/30 bg-black/20 p-4">
				<div className="flex items-start gap-2"><ShieldAlert size={18} className="mt-1 gold"/><div><h4 className="font-semibold">Administrator decision</h4><p className="mt-1 text-sm muted">Review the original evidence independently. Automated OCR, face comparison and liveness are unavailable. Approval may automatically advance an eligible account to Tier 3 when existing address and approved proof-of-address requirements are satisfied.</p></div></div>
				<label className="account-label mt-3 block text-xs">Customer-facing explanation or correction<textarea className="input mt-1 min-h-20" maxLength={1000} value={reason} onChange={event=>setReason(event.target.value)} placeholder="Required for rejection or resubmission"/></label>
				<label className="account-label mt-3 block text-xs">Internal review note<textarea className="input mt-1 min-h-20" maxLength={2000} value={internalNote} onChange={event=>setInternalNote(event.target.value)} placeholder="Visible only to administrators"/></label>
				{detail.documents.map(document=><label className="mt-2 flex items-center gap-2 text-sm" key={document.id}><input type="checkbox" checked={selectedDocumentIds.includes(document.id)} onChange={event=>setSelectedDocumentIds(current=>event.target.checked?[...current,document.id]:current.filter(id=>id!==document.id))}/>{document.documentSide||document.kind.replaceAll('_',' ')} · {document.filename}</label>)}
				<label className="mt-3 flex items-start gap-2 text-sm leading-6"><input className="mt-1" type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/><span>I independently reviewed this evidence, confirm this is the latest case, and acknowledge unavailable automated biometric/liveness checks.</span></label>
				<div className="mt-3 flex flex-wrap gap-2"><button className="btn min-h-11 bg-profit px-4 text-black disabled:opacity-50" type="button" disabled={!confirmed||busy||!detail.isLatest} onClick={()=>void decide('APPROVE')}><CheckCircle2 size={16}/>{busy?'Saving…':'Approve case'}</button><button className="btn min-h-11 bg-loss px-4 disabled:opacity-50" type="button" disabled={!confirmed||busy||!detail.isLatest||reason.trim().length<3} onClick={()=>void decide('REJECT')}>Reject</button><button className="btn min-h-11 bg-white/10 px-4 disabled:opacity-50" type="button" disabled={!confirmed||busy||!detail.isLatest||reason.trim().length<3||!selectedDocumentIds.length} onClick={()=>void decide('RESUBMISSION_REQUIRED')}>Request resubmission</button><button className="btn min-h-11 bg-white/10 px-4 disabled:opacity-50" type="button" disabled={!confirmed||busy||!detail.isLatest||internalNote.trim().length<3} onClick={()=>void decide('ESCALATE')}>Escalate</button></div>
			</section>}
		</article>}
	</section>;
}
