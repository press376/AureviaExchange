import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({process:vi.fn(),safeSecretEquals:vi.fn()}));

vi.mock('@/lib/kyc-retention',()=>({processKycRetentionBatch:mocks.process}));
vi.mock('@/lib/push-notifications',()=>({safeSecretEquals:mocks.safeSecretEquals}));

import {GET} from '@/app/api/cron/kyc-evidence-retention/route';

describe('KYC evidence retention cron route',()=>{
	beforeEach(()=>{
		vi.clearAllMocks();
		mocks.safeSecretEquals.mockReturnValue(false);
		mocks.process.mockResolvedValue({candidates:0,evidencePurged:0,metadataPurged:0,retriesScheduled:0});
	});

	it('requires the cron bearer authorization',async()=>{
		const response=await GET(new Request('http://localhost/api/cron/kyc-evidence-retention'));

		expect(response.status).toBe(401);
		expect(mocks.process).not.toHaveBeenCalled();
	});

	it('runs a bounded batch only after cron authorization succeeds',async()=>{
		mocks.safeSecretEquals.mockReturnValue(true);

		const response=await GET(new Request('http://localhost/api/cron/kyc-evidence-retention',{headers:{authorization:'Bearer cron-secret'}}));

		expect(response.status).toBe(200);
		expect(mocks.process).toHaveBeenCalledWith(3);
	});
});
