import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { OCR_QUEUE } from './ocr.constants';

export interface OcrJobPayload {
  userId: string;
  fileUrl: string;
  mimeType: string;
}

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);

  constructor(@InjectQueue(OCR_QUEUE) private readonly ocrQueue: Queue) {}

  async enqueue(payload: OcrJobPayload): Promise<string> {
    const job = await this.ocrQueue.add('process-receipt', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    });

    this.logger.log(`OCR job enqueued: ${job.id} for user ${payload.userId}`);
    return job.id as string;
  }
}
