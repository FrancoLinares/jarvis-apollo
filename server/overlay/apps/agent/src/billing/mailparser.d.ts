// Declaración mínima de lo que usa billing/mail.ts: mailparser no trae tipos y
// sumar @types/mailparser al build de producción no vale la pena por una función.
declare module 'mailparser' {
  export type ParsedMail = {
    readonly subject?: string;
    readonly text?: string;
    readonly html?: string | false;
    readonly date?: Date;
    readonly from?: { readonly text: string };
  };
  export function simpleParser(source: Buffer | string): Promise<ParsedMail>;
}
