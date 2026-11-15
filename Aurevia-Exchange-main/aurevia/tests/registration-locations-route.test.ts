import {describe,expect,it} from 'vitest';
import {GET} from '../app/api/registration/locations/route';

describe('registration location suggestions',()=>{
	it('returns offline region choices for supported countries',async()=>{
		const response=await GET(new Request('https://aurevia.test/api/registration/locations?country=US'));
		const body=await response.json() as {states:Array<{code:string;name:string}>};

		expect(response.status).toBe(200);
		expect(body.states).toContainEqual(expect.objectContaining({code:'CA',name:'California'}));
	});

	it('returns matching city suggestions while retaining manual-entry support',async()=>{
		const response=await GET(new Request('https://aurevia.test/api/registration/locations?country=US&query=New%20York'));
		const body=await response.json() as {cities:string[]};

		expect(response.status).toBe(200);
		expect(body.cities).toContain('New York City');
		expect(response.headers.get('cache-control')).toContain('max-age=300');
	});

	it('rejects invalid countries rather than returning misleading location data',async()=>{
		const response=await GET(new Request('https://aurevia.test/api/registration/locations?country=ZZ'));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({error:'Choose a valid country.'});
	});
});
