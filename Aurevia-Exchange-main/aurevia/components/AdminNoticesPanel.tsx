'use client';

import {FormEvent,useCallback,useEffect,useState} from 'react';
import {Archive,Check,Edit3,FileCheck2,Plus,RefreshCw,ShieldCheck} from 'lucide-react';

type NoticeType='ANNOUNCEMENT'|'TERMS'|'PRIVACY'|'RISK_DISCLOSURE'|'AML_KYC'|'DEPOSIT_WITHDRAWAL'|'PLATFORM_USAGE'|'COOKIE_POLICY'|'TRADING_AGREEMENT';
type Visibility='ADMIN_ONLY'|'HIDDEN'|'USERS'|'MANDATORY_ACCEPTANCE'|'SYSTEM_CRITICAL';
type NoticeStatus='DRAFT'|'PUBLISHED'|'UNPUBLISHED'|'ARCHIVED';
type Notice={
	id:string;type:NoticeType;title:string;content:string;version:string|null;visibility:Visibility;status:NoticeStatus;enabled:boolean;requiresReacceptance:boolean;
	startsAt:string|null;endsAt:string|null;publishedAt:string|null;unpublishedAt:string|null;createdAt:string;updatedAt:string;
	createdBy:{name:string|null;email:string}|null;updatedBy:{name:string|null;email:string}|null;
};
type Acceptance={id:string;version:string;acceptedAt:string;user:{id:string;name:string|null;email:string;aureviaExchangeId:string|null}|null};
type LegalAcceptance={id:string;documentKey:string;version:string;acceptedAt:string;auditMetadata:unknown;user:{id:string;name:string|null;email:string;aureviaExchangeId:string|null}|null};
type History={id:string;action:string;entityId:string|null;metadata:unknown;createdAt:string;actor:{name:string|null;email:string}|null};
type Draft={type:NoticeType;title:string;content:string;version:string;visibility:Visibility;requiresReacceptance:boolean;startsAt:string;endsAt:string};
type ResponseData={notices:Notice[];acceptances:Acceptance[];acceptanceTotal:number;legalAcceptances:LegalAcceptance[];legalAcceptanceTotal:number;acceptancePage:number;acceptancePageSize:number;history:History[]};

const initialDraft:Draft={type:'ANNOUNCEMENT',title:'',content:'',version:'',visibility:'HIDDEN',requiresReacceptance:false,startsAt:'',endsAt:''};

function localDate(value:string|null){
	if(!value)return '';
	const date=new Date(value);date.setMinutes(date.getMinutes()-date.getTimezoneOffset());
	return date.toISOString().slice(0,16);
}

function effectiveDate(value:string){
	return value?new Date(value).toISOString():null;
}

function visibilityOptions(type:NoticeType):Array<{value:Visibility;label:string}>{
	if(type==='TERMS')return [{value:'MANDATORY_ACCEPTANCE',label:'Mandatory acceptance'}];
	if(type!=='ANNOUNCEMENT')return [{value:'HIDDEN',label:'Hidden'},{value:'ADMIN_ONLY',label:'Admin only'},{value:'USERS',label:'Users · public policy'},{value:'MANDATORY_ACCEPTANCE',label:'Mandatory acceptance'}];
	return [{value:'HIDDEN',label:'Hidden'},{value:'ADMIN_ONLY',label:'Admin only'},{value:'USERS',label:'Users · Notifications inbox'},{value:'SYSTEM_CRITICAL',label:'System critical · Notifications inbox'}];
}

function formatDate(value:string|null|undefined){
	return value?new Date(value).toLocaleString():'Not set';
}

export default function AdminNoticesPanel(){
	const [data,setData]=useState<ResponseData>({notices:[],acceptances:[],acceptanceTotal:0,legalAcceptances:[],legalAcceptanceTotal:0,acceptancePage:1,acceptancePageSize:50,history:[]});
	const [draft,setDraft]=useState<Draft>(initialDraft);
	const [editingId,setEditingId]=useState('');
	const [acceptancePage,setAcceptancePage]=useState(1);
	const [loading,setLoading]=useState(true);
	const [busy,setBusy]=useState('');
	const [error,setError]=useState('');
	const [message,setMessage]=useState('');

	const load=useCallback(async(showLoading=false)=>{
		if(showLoading)setLoading(true);
		try{
			const response=await fetch(`/api/admin/notices?page=${acceptancePage}`,{cache:'no-store'});
			const result=await response.json() as ResponseData&{error?:string};
			if(!response.ok)throw new Error(result.error||'Unable to load Notices & Conditions.');
			setData(result);setError('');
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to load Notices & Conditions.')}
		finally{setLoading(false)}
	},[acceptancePage]);

	useEffect(()=>{void load(true)},[load]);

	function startEdit(item:Notice){
		setEditingId(item.id);
		setDraft({
			type:item.type,title:item.title,content:item.content,version:item.version||'',visibility:item.visibility,
			requiresReacceptance:item.requiresReacceptance,startsAt:localDate(item.startsAt),endsAt:localDate(item.endsAt),
		});
		setMessage('');
	}

	function changeType(type:NoticeType){
		const visibility=type==='TERMS'?'MANDATORY_ACCEPTANCE':'HIDDEN';
		setDraft(current=>({...current,type,visibility,version:type==='ANNOUNCEMENT'?'':current.version,requiresReacceptance:type!=='ANNOUNCEMENT'&&type!=='PRIVACY'}));
	}

	async function save(event:FormEvent<HTMLFormElement>){
		event.preventDefault();
		if(busy)return;
		setBusy('save');setError('');setMessage('');
		const payload={
			title:draft.title,content:draft.content,version:draft.type==='ANNOUNCEMENT'?null:draft.version.trim(),
			visibility:draft.visibility,requiresReacceptance:draft.requiresReacceptance,startsAt:effectiveDate(draft.startsAt),endsAt:effectiveDate(draft.endsAt),
			...(!editingId?{type:draft.type}:{}),
		};
		try{
			const response=await fetch('/api/admin/notices',{
				method:editingId?'PATCH':'POST',
				headers:{'content-type':'application/json'},
				body:JSON.stringify(editingId?{action:'update',id:editingId,...payload}:payload),
			});
			const result=await response.json() as {error?:string};
			if(!response.ok)throw new Error(result.error||'Unable to save this notice.');
			setEditingId('');setDraft(initialDraft);setMessage(editingId?'Notice changes saved.':'Draft created. It is not visible to users until published.');
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to save this notice.')}
		finally{setBusy('')}
	}

	async function transition(item:Notice,action:'publish'|'unpublish'|'enable'|'disable'|'archive'){
		if(busy)return;
		setBusy(`${item.id}:${action}`);setError('');setMessage('');
		try{
			const response=await fetch('/api/admin/notices',{
				method:'PATCH',
				headers:{'content-type':'application/json'},
				body:JSON.stringify({id:item.id,action}),
			});
			const result=await response.json() as {error?:string};
			if(!response.ok)throw new Error(result.error||'Unable to update notice status.');
			setMessage(`${item.title}: ${action} complete.`);
			await load();
		}catch(exception){setError(exception instanceof Error?exception.message:'Unable to update notice status.')}
		finally{setBusy('')}
	}

	const maxAcceptancePage=Math.max(1,Math.ceil(data.acceptanceTotal/data.acceptancePageSize));

	return <div className="account-page admin-notices-page">
		<header className="account-heading"><div><span className="account-kicker">ADMIN WORKSPACE · CONTENT GOVERNANCE</span><h1>Notices &amp; Conditions</h1><p>Create notices and manage immutable versions of Terms, Privacy, risk and platform policies. Drafts are hidden by default; published user announcements appear only in the Notifications inbox.</p></div><button type="button" className="icon-action" aria-label="Refresh notices" onClick={()=>void load(true)}><RefreshCw size={15}/></button></header>
		{error&&<p className="account-callout mb-3" role="alert">{error}</p>}{message&&<p className="mb-3 text-sm text-profit" role="status">{message}</p>}

		<section className="account-panel p-5">
			<div className="account-panel-title"><div><h2>{editingId?'Edit draft notice':'Create notice or policy version'}</h2><p className="account-panel-subtitle">Use reviewed legal text only. Policy versions cannot be edited after first publication; create a new version instead.</p></div><FileCheck2 size={18} className="gold"/></div>
			<form className="admin-notice-form mt-4" onSubmit={event=>void save(event)}>
				<label className="account-label">Content type<select className="input" value={draft.type} disabled={Boolean(editingId)} onChange={event=>changeType(event.target.value as NoticeType)}><option value="ANNOUNCEMENT">Announcement</option><option value="TERMS">Terms &amp; Conditions</option><option value="PRIVACY">Privacy Policy</option><option value="RISK_DISCLOSURE">Risk Disclosure</option><option value="AML_KYC">AML/KYC Policy</option><option value="DEPOSIT_WITHDRAWAL">Deposit &amp; Withdrawal Policy</option><option value="PLATFORM_USAGE">Platform Usage Policy</option><option value="COOKIE_POLICY">Cookie Policy</option><option value="TRADING_AGREEMENT">Trading Agreement</option></select></label>
				<label className="account-label">Visibility<select className="input" value={draft.visibility} onChange={event=>setDraft({...draft,visibility:event.target.value as Visibility})}>{visibilityOptions(draft.type).map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
				{draft.type!=='ANNOUNCEMENT'&&<label className="account-label">Policy version<input className="input" required maxLength={64} value={draft.version} onChange={event=>setDraft({...draft,version:event.target.value})} placeholder="For example, 2026-11-10"/></label>}
				<label className="account-label">Title<input className="input" required minLength={3} maxLength={160} value={draft.title} onChange={event=>setDraft({...draft,title:event.target.value})}/></label>
				<label className="account-label admin-notice-wide">Content<textarea className="input admin-notice-content" required maxLength={40000} value={draft.content} onChange={event=>setDraft({...draft,content:event.target.value})} placeholder="Plain text; HTML is not accepted or rendered."/></label>
				<label className="account-label">Effective from<input className="input" type="datetime-local" value={draft.startsAt} onChange={event=>setDraft({...draft,startsAt:event.target.value})}/></label>
				<label className="account-label">Effective until<input className="input" type="datetime-local" value={draft.endsAt} onChange={event=>setDraft({...draft,endsAt:event.target.value})}/></label>
				{draft.type!=='ANNOUNCEMENT'&&draft.visibility==='MANDATORY_ACCEPTANCE'&&<label className="account-label admin-notice-wide flex items-center gap-2"><input type="checkbox" checked={draft.requiresReacceptance||draft.type==='TERMS'} disabled={draft.type==='TERMS'} onChange={event=>setDraft({...draft,requiresReacceptance:event.target.checked})}/><span>Require renewed acceptance for this policy version</span></label>}
				<div className="admin-notice-wide flex flex-wrap items-center gap-2"><button className="btn bg-gold text-black" disabled={busy==='save'}>{busy==='save'?'Saving…':editingId?<><Check size={15}/> Save draft</>:<><Plus size={15}/> Create hidden draft</>}</button>{editingId&&<button type="button" className="btn bg-white/5" onClick={()=>{setEditingId('');setDraft(initialDraft)}}>Cancel edit</button>}</div>
			</form>
		</section>

		<section className="mt-5">
			<div className="account-panel-title mb-3"><div><h2>Notice and policy versions</h2><p className="account-panel-subtitle">Publishing and changes are recorded in the management history. Admin-only and hidden content is not returned to user endpoints.</p></div></div>
			{loading&&!data.notices.length?<p className="account-empty" role="status">Loading notices…</p>:data.notices.length?<div className="admin-notice-list">{data.notices.map(item=>{
				const canEdit=item.status!=='PUBLISHED'&&item.status!=='ARCHIVED'&&(item.type==='ANNOUNCEMENT'||!item.publishedAt);
				return <article className="admin-notice-card" key={item.id}>
					<div className="admin-notice-card-main"><div className="admin-notice-meta"><span>{item.type}</span><span>{item.status}{item.enabled?' · ENABLED':' · DISABLED'}</span><span>{item.visibility.replaceAll('_',' ')}</span>{item.version&&<span>Version {item.version}</span>}{item.requiresReacceptance&&<span>Renewed acceptance required</span>}</div><h3>{item.title}</h3><p className="admin-notice-body">{item.content}</p><small>Effective {formatDate(item.startsAt)} – {formatDate(item.endsAt)} · Updated {formatDate(item.updatedAt)} · {item.updatedBy?.name||item.updatedBy?.email||item.createdBy?.email||'Administrator'}</small></div>
					<div className="admin-notice-actions">
						{canEdit&&<button type="button" className="button-secondary" onClick={()=>startEdit(item)}><Edit3 size={14}/>Edit draft</button>}
						{(item.status==='DRAFT'||item.status==='UNPUBLISHED')&&<button type="button" className="button-secondary" disabled={Boolean(busy)} onClick={()=>void transition(item,'publish')}><Check size={14}/>Publish</button>}
						{item.status==='PUBLISHED'&&<><button type="button" className="button-secondary" disabled={Boolean(busy)} onClick={()=>void transition(item,item.enabled?'disable':'enable')}>{item.enabled?'Disable':'Enable'}</button><button type="button" className="button-secondary" disabled={Boolean(busy)} onClick={()=>void transition(item,'unpublish')}>Unpublish</button></>}
						{item.status!=='ARCHIVED'&&<button type="button" className="button-secondary" disabled={Boolean(busy)} onClick={()=>void transition(item,'archive')}><Archive size={14}/>Archive</button>}
					</div>
				</article>;
			})}</div>:<p className="account-empty">No managed notices or policy versions exist.</p>}
		</section>

		<section className="mt-5 account-panel p-5">
			<div className="account-panel-title"><div><h2>Persistent legal acceptance records</h2><p className="account-panel-subtitle">User, document key, immutable version, timestamp, and acceptance channel. Export is authorized and paginated.</p></div><div className="flex items-center gap-2">{data.legalAcceptances.length>0&&<a className="button-secondary" href={`/api/admin/notices?export=legal-acceptances&page=${acceptancePage}`}>Export this page</a>}<ShieldCheck size={18} className="gold"/></div></div>
			<div className="admin-notice-table-wrap"><table className="admin-notice-table"><thead><tr><th>User</th><th>Aurevia ID</th><th>Document</th><th>Version</th><th>Accepted at</th><th>Channel</th></tr></thead><tbody>{data.legalAcceptances.map(item=>{
				const metadata=item.auditMetadata&&typeof item.auditMetadata==='object'?'channel' in item.auditMetadata?item.auditMetadata.channel:'historical':'historical';
				return <tr key={item.id}><td>{item.user?.name||'Account unavailable'}<small>{item.user?.email||item.user?.id||'User record no longer exists'}</small></td><td>{item.user?.aureviaExchangeId||'—'}</td><td>{item.documentKey.replaceAll('_',' ')}</td><td>{item.version}</td><td>{formatDate(item.acceptedAt)}</td><td>{typeof metadata==='string'?metadata:'historical'}</td></tr>;
			})}</tbody></table></div>
			<p className="admin-notice-pagination"><span>Showing {data.legalAcceptances.length?((acceptancePage-1)*data.acceptancePageSize+1):0}–{Math.min(acceptancePage*data.acceptancePageSize,data.legalAcceptanceTotal)} of {data.legalAcceptanceTotal}</span><span><button type="button" className="button-secondary" disabled={acceptancePage<=1||loading} onClick={()=>setAcceptancePage(page=>page-1)}>Previous</button><button type="button" className="button-secondary" disabled={acceptancePage>=Math.max(1,Math.ceil(data.legalAcceptanceTotal/data.acceptancePageSize))||loading} onClick={()=>setAcceptancePage(page=>page+1)}>Next</button></span></p>
		</section>

		<section className="mt-5 account-panel p-5">
			<div className="account-panel-title"><div><h2>User Terms acceptance records</h2><p className="account-panel-subtitle">Historical acceptance entries are retained and shown read-only.</p></div><ShieldCheck size={18} className="gold"/></div>
			<div className="admin-notice-table-wrap"><table className="admin-notice-table"><thead><tr><th>User</th><th>Aurevia ID</th><th>Terms version</th><th>Accepted at</th></tr></thead><tbody>{data.acceptances.map(item=><tr key={item.id}><td>{item.user?.name||'Account unavailable'}<small>{item.user?.email||'User record no longer exists'}</small></td><td>{item.user?.aureviaExchangeId||'—'}</td><td>{item.version}</td><td>{formatDate(item.acceptedAt)}</td></tr>)}</tbody></table></div>
			<p className="admin-notice-pagination"><span>Showing {data.acceptances.length?((acceptancePage-1)*data.acceptancePageSize+1):0}–{Math.min(acceptancePage*data.acceptancePageSize,data.acceptanceTotal)} of {data.acceptanceTotal}</span><span><button type="button" className="button-secondary" disabled={acceptancePage<=1||loading} onClick={()=>setAcceptancePage(page=>page-1)}>Previous</button><button type="button" className="button-secondary" disabled={acceptancePage>=maxAcceptancePage||loading} onClick={()=>setAcceptancePage(page=>page+1)}>Next</button></span></p>
		</section>

		<section className="mt-5 account-panel p-5">
			<div className="account-panel-title"><div><h2>Publication and modification history</h2><p className="account-panel-subtitle">Audit records include before and after snapshots; policy versions remain separate records.</p></div></div>
			{data.history.length?<div className="admin-notice-history">{data.history.map(item=><details key={item.id}><summary><span>{item.action.replaceAll('_',' ')}</span><span>{item.actor?.name||item.actor?.email||'Administrator'} · {formatDate(item.createdAt)}</span></summary><pre>{JSON.stringify(item.metadata,null,2)}</pre></details>)}</div>:<p className="account-empty">No notice changes have been recorded.</p>}
		</section>
	</div>;
}
