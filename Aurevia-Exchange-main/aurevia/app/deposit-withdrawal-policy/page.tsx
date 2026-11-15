import InfoPage from '@/components/InfoPage';

export default function DepositWithdrawalPolicy(){
	return <InfoPage eyebrow="Account funding · Version 2026-11-15-v1" title="Deposits and withdrawals" lead="How funding requests and internal ledger records work in the current Aurevia application." updated="November 15, 2026" importantNote="A request in Aurevia is not proof of payment, custody, or external settlement. Do not send funds based only on a screen or message in this evaluation application." sections={[
		{title:'Funding requests',content:<p>REAL-mode funding requests remain pending until an administrator reviews and approves them. Any wallet credit is recorded through Aurevia’s internal ledger after approval. DEMO funds are simulated and have no cash value.</p>},
		{title:'Withdrawals',content:<p>Withdrawal requests are subject to account restrictions, KYC status, and administrator review. Pending requests reserve internal ledger funds. External payout is not performed automatically by the current application; an administrator must confirm any externally processed payout before the corresponding ledger debit is recorded.</p>},
		{title:'Fees and records',content:<p>Applicable configured fees are shown in the request workflow before approval. The ledger records the requested amount, approved amount, fees, and resulting balance changes for authorized account and administrator review.</p>},
	]}/>;
}
