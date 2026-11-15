import {KycVerificationStatus,Prisma} from '@prisma/client';
import {NextResponse} from 'next/server';
import {z,ZodError} from 'zod';
import {requireAdmin} from '@/lib/auth';
import {db} from '@/lib/db';

const querySchema=z.object({
	page:z.coerce.number().int().min(1).default(1),
	search:z.string().trim().max(120).default(''),
	status:z.nativeEnum(KycVerificationStatus).optional(),
	country:z.string().trim().regex(/^[A-Za-z]{2}$/).optional(),
	documentType:z.string().trim().max(32).optional(),
	risk:z.enum(['LOW','MEDIUM','HIGH','MANUAL_REVIEW_REQUIRED']).optional(),
	reviewer:z.string().trim().max(120).optional(),
	dateFrom:z.string().date().optional(),
	dateTo:z.string().date().optional(),
	sort:z.enum(['NEWEST','OLDEST']).default('NEWEST'),
}).refine(input=>!input.dateFrom||!input.dateTo||input.dateFrom<=input.dateTo,{path:['dateTo'],message:'Date range is invalid.'});
const pageSize=25;

export async function GET(request:Request){
	try{
		await requireAdmin();
		const input=querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
		const search=input.search;
		const where:Prisma.KycVerificationWhereInput={
			...(input.status?{status:input.status}:{}),
			...(input.country?{documentCountry:input.country.toUpperCase()}:{}),
			...(input.documentType?{documentType:input.documentType}:{}),
			...(input.dateFrom||input.dateTo?{submittedAt:{...(input.dateFrom?{gte:new Date(`${input.dateFrom}T00:00:00.000Z`)}:{}),...(input.dateTo?{lte:new Date(`${input.dateTo}T23:59:59.999Z`)}:{})}}:{}),
			...(input.reviewer?{assignedTo:{OR:[{name:{contains:input.reviewer,mode:'insensitive'}},{email:{contains:input.reviewer,mode:'insensitive'}}]}}:{}),
			...(search?{OR:[
				{id:{contains:search,mode:'insensitive'}},
				{userId:{contains:search,mode:'insensitive'}},
				{user:{OR:[{email:{contains:search,mode:'insensitive'}},{name:{contains:search,mode:'insensitive'}}]}},
			]}:{}),
			...(input.risk?{assessment:{path:['riskLevel'],equals:input.risk}}:{}),
		};
		const trendSince=new Date(Date.now()-30*24*60*60_000);
		const [items,total,counts,reviewed,highRiskCount,trends,workload]=await Promise.all([
			db.kycVerification.findMany({
				where,skip:(input.page-1)*pageSize,take:pageSize,orderBy:{submittedAt:input.sort==='OLDEST'?'asc':'desc'},
				select:{
					id:true,status:true,documentCountry:true,documentType:true,submittedAt:true,reviewedAt:true,reviewedById:true,assignedToId:true,assessment:true,
					user:{select:{id:true,name:true,email:true,accountMode:true,approvedTier:true,kycStatus:true}},
					documents:{select:{id:true,kind:true,documentSide:true,filename:true,mimeType:true,size:true,status:true,uploadedAt:true}},
					reviewedBy:{select:{name:true,email:true}},
					assignedTo:{select:{id:true,name:true,email:true}},
				},
			}),
			db.kycVerification.count({where}),
			db.kycVerification.groupBy({by:['status'],_count:{_all:true}}),
			db.kycVerification.findMany({where:{status:{in:['APPROVED','REJECTED']},submittedAt:{not:null},reviewedAt:{not:null}},select:{submittedAt:true,reviewedAt:true},take:500,orderBy:{reviewedAt:'desc'}}),
			db.kycVerification.count({where:{assessment:{path:['riskLevel'],equals:'HIGH'}}}),
			db.kycVerification.findMany({where:{submittedAt:{gte:trendSince}},select:{submittedAt:true}}),
			db.kycVerification.groupBy({by:['assignedToId'],where:{status:{in:['PENDING_REVIEW','NEEDS_REVIEW']},assignedToId:{not:null}},_count:{_all:true}}),
		]);
		const countByStatus=Object.fromEntries(counts.map(item=>[item.status,item._count._all]));
		const completed=reviewed.filter(item=>item.submittedAt&&item.reviewedAt);
		const averageReviewHours=completed.length
			?Math.round(completed.reduce((sum,item)=>sum+(item.reviewedAt!.getTime()-item.submittedAt!.getTime())/3_600_000,0)/completed.length*10)/10
			:null;
		const trendCounts=new Map<string,number>();
		for(const item of trends){
			if(!item.submittedAt)continue;
			const day=item.submittedAt.toISOString().slice(0,10);
			trendCounts.set(day,(trendCounts.get(day)||0)+1);
		}
		const reviewerIds=workload.flatMap(item=>item.assignedToId?[item.assignedToId]:[]);
		const reviewers=reviewerIds.length?await db.user.findMany({where:{id:{in:reviewerIds}},select:{id:true,name:true,email:true}}):[];
		const reviewerById=new Map(reviewers.map(item=>[item.id,item]));
		const unassignedWorkload=await db.kycVerification.count({where:{status:{in:['PENDING_REVIEW','NEEDS_REVIEW']},assignedToId:null}});
		const workloadItems:{reviewer:{id:string;name:string|null;email:string}|null;count:number}[]=[
			{reviewer:null,count:unassignedWorkload},
			...workload.flatMap(item=>{
				const reviewer=item.assignedToId?reviewerById.get(item.assignedToId):null;
				return reviewer?[{reviewer,count:item._count._all}]:[];
			}),
		];
		return NextResponse.json({
			items,total,page:input.page,pageSize,totalPages:Math.ceil(total/pageSize),
			stats:{
				total:Object.values(countByStatus).reduce((sum,value)=>sum+Number(value),0),
				pendingReview:countByStatus.PENDING_REVIEW||0,
				processing:countByStatus.PROCESSING||0,
				needsReview:countByStatus.NEEDS_REVIEW||0,
				approved:countByStatus.APPROVED||0,
				rejected:countByStatus.REJECTED||0,
				resubmissionRequired:countByStatus.RESUBMISSION_REQUIRED||0,
				highRisk:highRiskCount,
				averageReviewHours,
			},
			trends:[...trendCounts].sort(([left],[right])=>left.localeCompare(right)).map(([date,count])=>({date,count})),
			workload:workloadItems,
		},{headers:{'Cache-Control':'private, no-store'}});
	}catch(error){
		if(error instanceof Error&&error.message==='UNAUTHORIZED')return NextResponse.json({error:'Unauthorized'},{status:401});
		if(error instanceof Error&&error.message==='FORBIDDEN')return NextResponse.json({error:'Forbidden'},{status:403});
		if(error instanceof ZodError)return NextResponse.json({error:'Invalid review queue filters.'},{status:400});
		console.error('Administrator KYC queue could not be loaded.',{errorType:error instanceof Error?error.name:'UnknownError'});
		return NextResponse.json({error:'Unable to load the KYC review queue.'},{status:503,headers:{'Cache-Control':'private, no-store'}});
	}
}
