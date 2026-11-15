import RegistrationExperience from '@/components/RegistrationExperience';
import {getPublicConfiguration} from '@/lib/config/env';

export default function RegisterPage(){
	const {turnstileSiteKey}=getPublicConfiguration();
	return <RegistrationExperience turnstileSiteKey={turnstileSiteKey}/>;
}