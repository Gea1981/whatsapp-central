import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';

describe('WhatsAppWebJsAdapter message filtering', () => {
  it('ignores status@broadcast before downloading media or emitting the message', async () => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'session-1',
      sessionDataPath: './data/sessions',
    });
    const onMessage = jest.fn();
    const downloadMedia = jest.fn();
    const adapterInternals = adapter as unknown as {
      callbacks: { onMessage: typeof onMessage };
      handleMessage: (message: Record<string, unknown>) => Promise<void>;
    };
    adapterInternals.callbacks = { onMessage };

    await adapterInternals.handleMessage({
      id: { _serialized: 'status-message-1' },
      from: 'status@broadcast',
      to: '5493812345678@c.us',
      body: 'status',
      type: 'image',
      timestamp: 1_760_356_800,
      fromMe: false,
      hasMedia: true,
      downloadMedia,
      hasQuotedMsg: false,
    });

    expect(downloadMedia).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });
});
