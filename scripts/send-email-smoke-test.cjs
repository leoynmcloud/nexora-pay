// Sends one explicitly requested smoke test. The API key is read from stdin,
// never written to disk or printed. Reuse the same idempotency key on retry.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const readline = require('node:readline');
const { stripTypeScriptTypes } = require('node:module');

const [recipient, idempotencyKey] = process.argv.slice(2);
if (!recipient || !idempotencyKey) throw new Error('Recipient and idempotency key required');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/nexora-email-events/index.ts'), 'utf8');
const templateSource = source.slice(source.indexOf('const htmlEntities'), source.indexOf('async function sendEmail'));
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(templateSource), context);
const content = context.template('Seu e-mail de teste chegou!',
  'Este é um teste de envio dos avisos da Nexora Pay pelo Resend.',
  [['Ambiente', 'Teste de e-mail'], ['Destinatário', recipient]],
  'Nenhum cadastro foi aprovado e nenhuma transação foi criada. Este teste verifica o remetente e o template; não substitui o teste dos eventos autenticados da plataforma.');

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.once('line', async (line) => {
  input.close();
  try {
    const key = line.trim();
    if (!key.startsWith('re_')) throw new Error('Invalid key format');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ from: 'Nexora Pay <avisos@nexorapay.me>', to: [recipient], reply_to: 'nexorapay.contato@gmail.com', subject: '[TESTE] Nexora Pay — configuração de e-mails', ...content }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    console.log(JSON.stringify({ accepted: response.ok, status: response.status, id: result.id, error: result.name }));
    process.exit(response.ok ? 0 : 1);
  } catch (error) {
    console.error(JSON.stringify({ accepted: false, error: error.name }));
    process.exit(1);
  }
});
