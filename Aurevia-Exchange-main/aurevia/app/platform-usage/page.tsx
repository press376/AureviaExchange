import InfoPage from '@/components/InfoPage';

export default function PlatformUsagePolicy(){
	return <InfoPage eyebrow="Platform guidance · Version 2026-11-15-v1" title="Platform usage" lead="Important operating distinctions for Aurevia Exchange accounts." updated="November 15, 2026" importantNote="This page summarizes current product behavior. Review the Terms & Conditions and Risk Disclosure for the corresponding platform terms and risks." sections={[
		{title:'Account modes',content:<p>DEMO activity uses simulated funds and does not have cash value. REAL mode begins with a zero wallet balance and does not grant eligibility, identity approval, funding approval, or live brokerage access.</p>},
		{title:'Trading and market data',content:<p>Orders use the platform’s configured simulated or sandbox execution path. Aurevia does not represent simulated fills as live financial-market execution. Market data availability and freshness depend on the configured provider and are identified in the product interface.</p>},
		{title:'Account security',content:<p>Keep your password and authentication devices private. Contact support if you believe an account or security credential has been accessed without authorization. Never place passwords, one-time codes, or provider credentials in support messages.</p>},
	]}/>;
}
