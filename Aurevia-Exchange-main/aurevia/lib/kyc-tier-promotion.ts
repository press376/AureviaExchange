import {AccountMode,NotificationType,Prisma,TierUpgradeStatus} from '@prisma/client';
import {enqueueKycEmail} from '@/lib/kyc-email-outbox';
import {createNotification} from '@/lib/notifications';
import {getTierProfileRequirements,validateTierThreeApproval} from '@/lib/production-policy';
import {synchronizeCompletedProfileTier} from '@/lib/tier-progression';

export async function promoteApprovedKycCaseToTierThree(
	tx:Prisma.TransactionClient,
	input:{userId:string;verificationId:string;administratorId:string;now?:Date},
){
	const now=input.now??new Date();
	const [verification,user,caseDocuments]=await Promise.all([
		tx.kycVerification.findFirst({where:{id:input.verificationId,userId:input.userId,status:'APPROVED'},select:{id:true}}),
		tx.user.findUnique({where:{id:input.userId},select:{
			id:true,role:true,status:true,accountMode:true,approvedTier:true,kycStatus:true,name:true,country:true,phone:true,
			kyc:{select:{address:true}},
			kycDocuments:{where:{kind:'PROOF_OF_ADDRESS'},select:{status:true}},
		}}),
		tx.kycDocument.findMany({where:{verificationId:input.verificationId,status:'APPROVED'},select:{kind:true}}),
	]);
	if(!verification||!user||user.role!=='USER'||user.status!=='ACTIVE'||user.accountMode!==AccountMode.REAL||user.kycStatus!=='APPROVED'||user.approvedTier>=3)return false;
	if(!caseDocuments.some(document=>document.kind==='IDENTITY_DOCUMENT')||!caseDocuments.some(document=>document.kind==='SELFIE'))return false;
	const profileRequirements=getTierProfileRequirements(user);
	if(!profileRequirements.profileComplete)return false;
	const approvedProofOfAddress=user.kycDocuments.filter(document=>document.status==='APPROVED').length;
	try{
		validateTierThreeApproval({
			profileComplete:profileRequirements.profileComplete,
			kycStatus:user.kycStatus,
			approvedProofOfAddress,
			addressProvided:Boolean(user.kyc?.address?.trim()),
		});
	}catch(error){
		if(error instanceof Error&&error.message==='TIER_3_REQUIREMENTS_NOT_MET')return false;
		throw error;
	}

	await synchronizeCompletedProfileTier(tx,user.id);
	const promoted=await tx.user.updateMany({
		where:{id:user.id,role:'USER',status:'ACTIVE',accountMode:AccountMode.REAL,approvedTier:{lt:3},kycStatus:'APPROVED'},
		data:{approvedTier:3},
	});
	if(promoted.count!==1)return false;
	await tx.tierUpgradeRequest.updateMany({
		where:{userId:user.id,status:{in:[TierUpgradeStatus.PENDING_REVIEW,TierUpgradeStatus.NEEDS_INFORMATION]}},
		data:{status:TierUpgradeStatus.APPROVED,adminReason:'Automatically approved with the administrator-approved KYC case.',reviewedById:input.administratorId,reviewedAt:now},
	});
	await tx.auditLog.create({data:{
		actorId:input.administratorId,
		action:'KYC_TIER_AUTO_PROMOTED',
		entity:'KYC_VERIFICATION',
		entityId:verification.id,
		metadata:{userId:user.id,previousTier:user.approvedTier,newTier:3},
	}});
	await createNotification(tx,{
		userId:user.id,
		type:NotificationType.ACCOUNT,
		title:'Identity verification approved — Tier 3',
		message:'Your Aurevia identity verification has been approved. Your account has automatically been upgraded to Tier 3. You can now access the features available to your approved account level.',
		dedupeKey:`kyc-verification:${verification.id}:tier3`,
		actionUrl:'/tier',
	});
	await enqueueKycEmail(tx,user.id,'VERIFICATION_TIER3_APPROVED',`kyc-verification:${verification.id}:tier3`);
	return true;
}
