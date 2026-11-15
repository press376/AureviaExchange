import {beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({
	getServerSession:vi.fn(),
	getLegalAcceptanceStatus:vi.fn(),
}));

vi.mock('next-auth',()=>({getServerSession:mocks.getServerSession}));
vi.mock('@/lib/auth-options',()=>({authOptions:{}}));
vi.mock('@/lib/legal-acceptance',()=>({getLegalAcceptanceStatus:mocks.getLegalAcceptanceStatus}));

import {requireAdmin,requireUser} from '@/lib/auth';

const sessionUser={id:'user-a',role:'USER',sessionHash:'a'.repeat(64)};

beforeEach(()=>{
	vi.clearAllMocks();
	mocks.getServerSession.mockResolvedValue({user:sessionUser});
	mocks.getLegalAcceptanceStatus.mockResolvedValue([{accepted:true},{accepted:true}]);
});

describe('legal acceptance authorization',()=>{
	it('allows a user after accepting all current applicable versions',async()=>{
		await expect(requireUser()).resolves.toMatchObject({id:'user-a'});
		expect(mocks.getLegalAcceptanceStatus).toHaveBeenCalledWith('user-a');
	});

	it('denies protected API access when any required version is outstanding',async()=>{
		mocks.getLegalAcceptanceStatus.mockResolvedValue([{accepted:true},{accepted:false}]);
		await expect(requireUser()).rejects.toThrow('FORBIDDEN');
	});

	it('requires the newly published mandatory version even when an older version was accepted',async()=>{
		mocks.getServerSession.mockResolvedValue({user:{id:'admin-a',role:'ADMIN'}});
		mocks.getLegalAcceptanceStatus.mockResolvedValue([{accepted:false}]);
		await expect(requireAdmin()).rejects.toThrow('FORBIDDEN');
		expect(mocks.getLegalAcceptanceStatus).toHaveBeenCalledWith('admin-a');
	});

	it('keeps acceptance status and submission endpoints accessible before acceptance',async()=>{
		mocks.getLegalAcceptanceStatus.mockResolvedValue([{accepted:false}]);
		await expect(requireUser({skipTermsAcceptance:true})).resolves.toMatchObject({id:'user-a'});
		expect(mocks.getLegalAcceptanceStatus).not.toHaveBeenCalled();
	});
});
