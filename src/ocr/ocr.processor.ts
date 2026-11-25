import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { OCR_QUEUE } from './ocr.constants';
import { OcrJobPayload } from './ocr.service';

@Processor(OCR_QUEUE, { concurrency: 2 })
export class OcrProcessor extends WorkerHost {
  private readonly logger = new Logger(OcrProcessor.name);

  async process(job: Job<OcrJobPayload>): Promise<void> {
    this.logger.log(`Processing OCR job ${job.id} for user ${job.data.userId}`);

    // TODO: implementar extração NF-e / NFC-e XML
    // 1. Download do arquivo via fileUrl
    // 2. Parse XML NF-e
    // 3. Salvar TransactionDraft com status pending_review
    // 4. Notificar usuário via WhatsApp

    this.logger.log(`OCR job ${job.id} completed`);
  }
}
