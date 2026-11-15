'use client';

import {useEffect,useState} from 'react';
import Link from 'next/link';
import Nav from '@/components/Nav';

type Acceptance={documentKey:string;version:string;acceptedAt:string;auditMetadata:unknown;source:string};
type ManagedVersion={id:string;type:string;title:string;content:string;version:string|null;status:string;requiresReacceptance:boolean;publishedAt:string|null;startsAt:string|null;endsAt:string|null};
type StaticDocument={documentKey:string;title:string;href:string;version:string;accepted:boolean;acceptedAt:string|null};
type LegalCentreData={documents:StaticDocument[];versions:ManagedVersion[];acceptances:Acceptance[]};

function formatDate(value:string|null){
	return value?new Date(value).toLocaleString():'Not recorded';
}

export default function LegalCentrePage(){
	const [data,setData]=useState<LegalCentreData|null>(null);
	const [error,setError]=useState('');

	useEffect(()=>{
		let active=true;
		void fetch('/api/legal-centre',{cache:'no-store'}).then(async response=>{
			const result=await response.json();
			if(!response.ok)throw new Error(result.error||'Unable to load Legal Centre.');
			if(active)setData(result);
		}).catch(exception=>{if(active)setError(exception instanceof Error?exception.message:'Unable to load Legal Centre.')});
		return()=>{active=false};
	},[]);

	return <><Nav/><main className="account-page">
		<header className="account-heading"><div><span className="account-kicker">AUREVIA EXCHANGE</span><h1>Legal Centre</h1><p>Current policies, published version history, and your recorded acceptance status.</p></div></header>
		{error&&<p className="account-callout" role="alert">{error}</p>}
		{!data&&!error&&<p className="account-empty" role="status">Loading legal documents…</p>}
		{data&&<>
			<section className="account-panel card p-5"><h2 className="text-lg font-semibold">Current policies and acceptance status</h2><div className="mt-3 divide-y divide-white/10">{data.documents.map(document=><article className="flex flex-wrap items-center justify-between gap-3 py-3" key={document.documentKey}><div><Link className="text-link font-semibold" href={document.href}>{document.title}</Link><p className="mt-1 text-xs muted">Current version {document.version} · {document.accepted?'Accepted':'Acceptance not recorded'}{document.acceptedAt?` · ${formatDate(document.acceptedAt)}`:''}</p></div><span className="status-pill">{document.accepted?'Accepted':'Review required'}</span></article>)}</div></section>
			<section className="account-panel card mt-5 p-5"><h2 className="text-lg font-semibold">Published document versions</h2><p className="mt-1 text-sm muted">Published, unpublished, and archived managed versions remain readable here. Drafts are not exposed.</p>{data.versions.length?<div className="mt-3 divide-y divide-white/10">{data.versions.map(version=><details className="py-3" key={version.id}><summary className="cursor-pointer"><span className="font-semibold">{version.title}</span><span className="ml-2 text-xs muted">{version.type} · v{version.version||'unversioned'} · {version.status} · published {formatDate(version.publishedAt)}</span></summary><p className="mt-1 text-xs muted">Effective {formatDate(version.startsAt)} – {formatDate(version.endsAt)}{version.requiresReacceptance?' · acceptance required for applicable accounts':''}</p><pre className="mt-3 whitespace-pre-wrap break-words text-sm">{version.content}</pre></details>)}</div>:<p className="mt-3 text-sm muted">No managed historical versions are published.</p>}</section>
			<section className="account-panel card mt-5 p-5"><h2 className="text-lg font-semibold">Your acceptance history</h2>{data.acceptances.length?<div className="mt-3 divide-y divide-white/10">{data.acceptances.map((acceptance,index)=><p className="break-all py-2 text-sm" key={`${acceptance.documentKey}:${acceptance.version}:${acceptance.acceptedAt}:${index}`}>{acceptance.documentKey.replaceAll('_',' ')} · v{acceptance.version} · {formatDate(acceptance.acceptedAt)}</p>)}</div>:<p className="mt-3 text-sm muted">Sign in to view your account’s acceptance records.</p>}</section>
		</>}
	</main></>;
}
