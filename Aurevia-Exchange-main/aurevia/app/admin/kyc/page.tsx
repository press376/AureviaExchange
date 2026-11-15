import {redirect} from 'next/navigation';
import AdminKycReviewPanel from '@/components/AdminKycReviewPanel';
import AdminKycCasesPanel from '@/components/AdminKycCasesPanel';
import AdminNav from '@/components/AdminNav';
import {requireAdmin} from '@/lib/auth';

export default async function PendingKycPage(){
	try{await requireAdmin()}catch{redirect('/admin/login')}
	return <><AdminNav/><main className="account-page"><header className="account-heading"><div><span className="account-kicker">ACCOUNT REVIEW</span><h1>Identity verification</h1><p>Review Aurevia Verify applications alongside retained Didit and legacy KYC records.</p></div></header><AdminKycCasesPanel/><AdminKycReviewPanel/></main></>;
}