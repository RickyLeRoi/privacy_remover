import { NextFunction, Request, RequestHandler, Response, Router } from "express";

// 20260715 RG - Express 4 non intercetta le rejection dei gestori async: se una route
// `async` lancia, l'error handler di index.ts non viene mai invocato, nessuna risposta
// parte e il client resta appeso per sempre (nella dashboard: uno spinner infinito).
// Il processo sopravvive, quindi il problema passa inosservato.
//
// Va usato al posto di Router() in TUTTI i file di rotta: basta dimenticarlo in uno
// perché quelle rotte tornino ad appendersi. Rimuovibile passando a Express 5, che
// gestisce le rejection async nativamente.

const METHODS = ["get", "post", "put", "patch", "delete", "all", "use"] as const;

function forwardRejections(handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // I middleware sincroni (es. multer) tornano undefined: niente da agganciare.
      const result: unknown = handler(req, res, next);
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        (result as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
}

export function asyncRouter(): Router {
  const router = Router();

  for (const method of METHODS) {
    const original = (router[method] as (...args: unknown[]) => unknown).bind(router);

    (router as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      original(
        ...args.map((arg) =>
          typeof arg === "function" ? forwardRejections(arg as RequestHandler) : arg
        )
      );
  }

  return router;
}
