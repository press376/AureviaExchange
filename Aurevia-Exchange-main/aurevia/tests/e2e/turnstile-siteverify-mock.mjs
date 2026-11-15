const siteverifyUrl='https://challenges.cloudflare.com/turnstile/v0/siteverify';
const originalFetch=globalThis.fetch;

if(process.env.AUREVIA_E2E_TURNSTILE_MOCK==='1'){
	globalThis.fetch=async(input,init)=>{
		const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
		if(url!==siteverifyUrl)return originalFetch(input,init);

		const body=init?.body;
		const parameters=body instanceof URLSearchParams?body:new URLSearchParams(body);
		const token=parameters.get('response');
		const expectedSecret=process.env.TURNSTILE_SECRET_KEY;
		if(!token||!expectedSecret||parameters.get('secret')!==expectedSecret){
			return new Response(JSON.stringify({success:false,'error-codes':['invalid-input-response']}),{
				status:200,headers:{'content-type':'application/json'},
			});
		}

		const hostname=new URL(process.env.NEXT_PUBLIC_APP_URL).hostname;
		return new Response(JSON.stringify({success:true,action:'register',hostname}),{
			status:200,headers:{'content-type':'application/json'},
		});
	};
}
