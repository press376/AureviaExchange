import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {hasMatchingFileExtension} from '@/lib/private-storage';

export const kycConsentVersion='aurevia-verify-2026-11';
export const kycRegistryVersion='aurevia-document-registry-v1';
export const maxKycImageBytes=8*1024*1024;
export const maxKycImagePixels=40_000_000;

export const kycDocumentRegistry={
	PASSPORT:{enabled:true,label:'International passport',sides:['FRONT'],mrzSupported:true,expiryRequired:true,portraitRequired:true},
	NATIONAL_ID:{enabled:true,label:'National identity card',sides:['FRONT','BACK'],mrzSupported:false,expiryRequired:false,portraitRequired:true},
	DRIVING_LICENCE:{enabled:true,label:'Driving licence',sides:['FRONT','BACK'],mrzSupported:false,expiryRequired:true,portraitRequired:true},
	RESIDENCE_PERMIT:{enabled:true,label:'Residence permit',sides:['FRONT','BACK'],mrzSupported:false,expiryRequired:true,portraitRequired:true},
	OTHER:{enabled:false,label:'Other identity document',sides:['FRONT','BACK'],mrzSupported:false,expiryRequired:false,portraitRequired:false},
} as const;

export type KycDocumentType=keyof typeof kycDocumentRegistry;
export type KycImageSide='FRONT'|'BACK'|'SELFIE'|'PROOF_OF_ADDRESS';
export type KycCheckOutcome='PASSED'|'FAILED'|'INCONCLUSIVE'|'NOT_AVAILABLE'|'NOT_APPLICABLE';

export class KycInputError extends Error {
	constructor(message:string,readonly status=400){super(message);this.name='KycInputError';}
}

function detectImageMime(bytes:Buffer):string|null{
	if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
	if(bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
	if(bytes.length>=12&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
	return null;
}

export async function validateKycImage(file:File,side:KycImageSide){
	if(file.size===0)throw new KycInputError('Choose a non-empty image file.');
	if(file.size>maxKycImageBytes)throw new KycInputError('Each verification image must be 8 MB or smaller.',413);
	const bytes=Buffer.from(await file.arrayBuffer());
	const mime=detectImageMime(bytes);
	if(!mime||mime!==file.type||!hasMatchingFileExtension(file.name,mime))throw new KycInputError('Use a valid JPEG, PNG, or WebP image whose file type matches its extension.',415);

	try{
		const image=sharp(bytes,{limitInputPixels:maxKycImagePixels,failOn:'warning'});
		const metadata=await image.metadata();
		if(metadata.format!==mime.slice('image/'.length)||!metadata.width||!metadata.height)throw new KycInputError('The image could not be read.');
		if(metadata.width>8000||metadata.height>8000||metadata.width*metadata.height>maxKycImagePixels)throw new KycInputError('The image dimensions are too large.',413);
		const minimum=side==='SELFIE'?250:400;
		if(metadata.width<minimum||metadata.height<minimum)throw new KycInputError('The image resolution is too low. Retake or upload a larger image.');
		await image.clone().resize({width:64,height:64,fit:'inside',withoutEnlargement:true}).toBuffer();
		return {
			bytes,
			mime,
			width:metadata.width,
			height:metadata.height,
			sha256:createHash('sha256').update(bytes).digest('hex'),
		};
	}catch(error){
		if(error instanceof KycInputError)throw error;
		throw new KycInputError('The image is corrupt or cannot be decoded.');
	}
}

export function createManualReviewAssessment(){
	const unavailable=(check:string,reason:string)=>({check,outcome:'NOT_AVAILABLE' as const,reason});
	return {
		engine:'manual-review-only',
		modelVersion:null,
		riskLevel:'MANUAL_REVIEW_REQUIRED',
		checks:[
			{check:'UPLOAD_INTEGRITY',outcome:'PASSED' as const,reason:'The image signatures, file types, dimensions, and decodability were validated.'},
			unavailable('DOCUMENT_QUALITY','Automated glare, sharpness, and layout analysis is not configured.'),
			unavailable('OCR_FIELDS','No OCR engine is configured; document fields were not machine-extracted.'),
			unavailable('MRZ_CHECKSUM','No MRZ parser is configured.'),
			unavailable('DOCUMENT_AUTHENTICITY','No issuer authentication is performed.'),
			unavailable('FACE_DETECTION','No biometric analysis engine is configured.'),
			unavailable('FACE_MATCH','No licensed and calibrated face-comparison model is configured.'),
			unavailable('LIVENESS','No validated presentation-attack detection model is configured.'),
			unavailable('DUPLICATE_IDENTITY','Privacy-preserving duplicate matching is not configured.'),
		],
	};
}
