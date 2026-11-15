import {describe,expect,it} from 'vitest';
import sharp from 'sharp';
import {createManualReviewAssessment,kycDocumentRegistry,validateKycImage} from '@/lib/kyc-verification';

async function image(width=640,height=480){
	return sharp({create:{width,height,channels:3,background:{r:70,g:90,b:80}}}).png().toBuffer();
}

describe('Aurevia Verify evidence validation',()=>{
	it('accepts a decodable image with a matching signature, MIME type and extension',async()=>{
		const bytes=await image();
		const result=await validateKycImage(new File([bytes],'identity.png',{type:'image/png'}),'FRONT');

		expect(result).toMatchObject({mime:'image/png',width:640,height:480});
		expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it('rejects spoofed MIME types and extensions',async()=>{
		const bytes=await image();

		await expect(validateKycImage(new File([bytes],'identity.jpg',{type:'image/jpeg'}),'FRONT')).rejects.toThrow('file type matches its extension');
	});

	it('rejects low-resolution and excessive-dimension images',async()=>{
		await expect(validateKycImage(new File([await image(200,200)],'small.png',{type:'image/png'}),'SELFIE')).rejects.toThrow('resolution is too low');
		await expect(validateKycImage(new File([await image(8100,900)],'wide.png',{type:'image/png'}),'FRONT')).rejects.toThrow('dimensions are too large');
	});

	it('fails closed on corrupt image data',async()=>{
		const corrupt=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);

		await expect(validateKycImage(new File([corrupt],'corrupt.png',{type:'image/png'}),'FRONT')).rejects.toThrow('corrupt or cannot be decoded');
	});

	it('marks unavailable identity and liveness automation for human review',()=>{
		const assessment=createManualReviewAssessment();
		const checks=new Map(assessment.checks.map(check=>[check.check,check.outcome]));

		expect(assessment.riskLevel).toBe('MANUAL_REVIEW_REQUIRED');
		expect(checks.get('UPLOAD_INTEGRITY')).toBe('PASSED');
		expect(checks.get('OCR_FIELDS')).toBe('NOT_AVAILABLE');
		expect(checks.get('FACE_MATCH')).toBe('NOT_AVAILABLE');
		expect(checks.get('LIVENESS')).toBe('NOT_AVAILABLE');
		expect(kycDocumentRegistry.PASSPORT.sides).toEqual(['FRONT']);
		expect(kycDocumentRegistry.NATIONAL_ID.sides).toEqual(['FRONT','BACK']);
	});
});
