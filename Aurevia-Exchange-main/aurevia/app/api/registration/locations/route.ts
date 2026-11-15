import {NextResponse} from 'next/server';
import {City,State} from 'country-state-city';
import {z} from 'zod';
import {findCountry} from '@/lib/countries';

const querySchema=z.object({
	country:z.string().regex(/^[A-Z]{2}$/),
	state:z.string().trim().max(100).optional(),
	query:z.string().trim().max(80).optional(),
});

export async function GET(request:Request){
	const params=new URL(request.url).searchParams;
	const parsed=querySchema.safeParse({
		country:params.get('country')||'',
		state:params.get('state')||undefined,
		query:params.get('query')||undefined,
	});
	if(!parsed.success||!findCountry(parsed.data.country)){
		return NextResponse.json({error:'Choose a valid country.'},{status:400,headers:{'Cache-Control':'no-store'}});
	}

	const {country,state,query}=parsed.data;
	if(query&&query.length>=2){
		const countryStates=State.getStatesOfCountry(country);
		const matchedState=state
			?countryStates.find(item=>item.isoCode.toLowerCase()===state.toLowerCase()||item.name.toLowerCase()===state.toLowerCase())
			:null;
		const cities=(matchedState
			?City.getCitiesOfState(country,matchedState.isoCode)
			:City.getCitiesOfCountry(country))||[];
		const normalizedQuery=query.toLocaleLowerCase();
		const suggestions=[...new Set(cities
			.filter(city=>city.name.toLocaleLowerCase().includes(normalizedQuery))
			.map(city=>city.name))].slice(0,30);
		return NextResponse.json({cities:suggestions},{headers:{'Cache-Control':'public, max-age=300, stale-while-revalidate=900'}});
	}

	const states=State.getStatesOfCountry(country).map(item=>({code:item.isoCode,name:item.name}));
	return NextResponse.json({states},{headers:{'Cache-Control':'public, max-age=3600, stale-while-revalidate=86400'}});
}
