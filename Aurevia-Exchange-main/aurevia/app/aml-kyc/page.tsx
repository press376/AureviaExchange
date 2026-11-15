import InfoPage from '@/components/InfoPage';

export default function AmlKycPolicy(){
	return <InfoPage eyebrow="Account verification · Version 2026-11-15-v1" title="Identity and account review" lead="How Aurevia currently handles identity-verification workflows." updated="November 15, 2026" importantNote="This is a product-process summary, not legal or compliance advice. It does not claim that Aurevia performs automated AML, sanctions, or regulatory screening." sections={[
		{title:'Identity verification',content:<p>REAL-mode users may initiate an identity-verification session through Didit when the configured service is available. Didit returns the verification status to Aurevia. An account is not approved merely because a session was created or a user selected REAL mode.</p>},
		{title:'Account review',content:<p>Identity documents and proof-of-address submissions are handled through the configured private-storage and administrator-review workflows. Results and administrator actions are recorded in the account history. Do not submit documents in an evaluation environment.</p>},
		{title:'Service limitations',content:<p>Provider availability and account eligibility can vary. This application does not represent that a provider result replaces independent compliance review or jurisdiction-specific obligations.</p>},
	]}/>;
}
