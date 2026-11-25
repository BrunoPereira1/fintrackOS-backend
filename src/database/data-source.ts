import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { buildTypeOrmConfig } from '../config';

dotenv.config();

export const AppDataSource = new DataSource(buildTypeOrmConfig(process.env));
