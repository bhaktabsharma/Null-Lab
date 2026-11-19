// @fastify/cookie augments FastifyReply/FastifyRequest with setCookie/
// clearCookie/cookies types as a side effect of importing its types. Lab
// target scripts only ever import from "@nulllab/lab-sdk" (never directly
// from "@fastify/cookie"), so without this re-export those methods would
// type-check as missing wherever a lab calls reply.setCookie(...).
import "@fastify/cookie";
