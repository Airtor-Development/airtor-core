import { Injectable, Logger } from '@nestjs/common';
import { DistributionData } from './schemas/distribution-data';
import { ScoreData } from './schemas/score-data';
import { Contract, LoggerFactory, Warp, WarpFactory } from 'warp-contracts';
import { AddScores, DistributionState, Score } from 'src/distribution/interfaces/distribution';
import { ConfigService } from '@nestjs/config';
import { Wallet } from 'ethers';
import { EthersExtension } from 'warp-contracts-plugin-ethers';
import {
    buildEvmSignature,
    EvmSignatureVerificationServerPlugin,
    // @ts-ignore
} from 'warp-contracts-plugin-signature/server'
import { StateUpdatePlugin } from 'warp-contracts-subscription-plugin';
import { Distribute } from './interfaces/distribution';

@Injectable()
export class DistributionService {
    private readonly logger = new Logger(DistributionService.name)

    private isLive?: string
    private owner

    private static readonly scoresPerBatch = 8
    
    private distributionWarp: Warp
    private distributionContract: Contract<DistributionState>

    constructor(
        private readonly config: ConfigService<{
            IS_LIVE: string
            DISTRIBUTION_CONTRACT_TXID: string
            DISTRIBUTION_CONTRACT_DATA_KEY: string
        }>,
    ) {
        LoggerFactory.INST.logLevel('error')

        this.isLive = config.get<string>('IS_LIVE', { infer: true })

        this.logger.log(
            `Initializing Verification Service IS_LIVE: ${this.isLive}`,
        )

        const distributionDataKey = this.config.get<string>('DISTRIBUTION_CONTRACT_DATA_KEY', {
            infer: true,
        })

        if (distributionDataKey !== undefined) {

            const signer = new Wallet(distributionDataKey)

            this.owner = {
                address: signer.address,
                key: distributionDataKey,
                signer: signer,
            }

            this.logger.log(
                `Initialized Validator in Distribution service for address: ${this.owner.address}`,
            )

            const distributionContractTxId = this.config.get<string>(
                'DISTRIBUTION_CONTRACT_TXID',
                { 
                    infer: true,
                }
            )

            if (distributionContractTxId != undefined) {
                this.logger.log(
                    `Initialized Validator with distribution contract: ${distributionContractTxId}`,
                )
                
                this.distributionWarp = WarpFactory.forMainnet({
                    inMemory: true,
                    dbLocation: '-distribution',
                })
                    .use(new EthersExtension())
                    .use(new EvmSignatureVerificationServerPlugin())
                this.distributionWarp.use(new StateUpdatePlugin(distributionContractTxId, this.distributionWarp))
                
                this.distributionContract =
                    this.distributionWarp.contract<DistributionState>(distributionContractTxId)
                
            } else this.logger.error('Missing distribution contract txid')

        } else this.logger.error('Missing contract owner key...')
    }

    public groupScoreJobs(
        data: DistributionData,
    ): ScoreData[][] {
        return data.scores.reduce<ScoreData[][]>(
            (curr, score, index, array): ScoreData[][] => {
                if (curr.length == 0) {
                    curr.push([score])
                } else {
                    if (curr[curr.length - 1].length < DistributionService.scoresPerBatch) {
                        const last = curr.pop()
                        if (last != undefined) {
                            last.push(score)
                            curr.push(last)
                        } else {
                            this.logger.error('Last element not found, this should not happen')
                        }
                    } else {
                        curr.push([score])
                    }
                }
                return curr;
            }, []
        );
    }

    public async addScores(
        stamp: number, scores: Score[]
    ): Promise<Score[]> {
        if (this.owner != undefined) {
            const evmSig = await buildEvmSignature(this.owner.signer)
            const response = await this.distributionContract
                .connect({
                    signer: evmSig,
                    type: 'ethereum',
                })
                .writeInteraction<AddScores>({
                    function: 'addScores',
                    timestamp: stamp.toString(),
                    scores: scores,
                })
            if (response?.originalTxId != undefined) {
                return scores
            } else {
                this.logger.error(`Failed storing scores for ${stamp}`)
                return []
            }
        } else {
            this.logger.error('Owner is undefined... skipping adding scores ')
            return []
        }
    }

    public async distribute(
        stamp: number
    ): Promise<boolean> {
        if (this.owner != undefined) {
            const evmSig = await buildEvmSignature(this.owner.signer)
            const response = await this.distributionContract
                .connect({
                    signer: evmSig,
                    type: 'ethereum',
                })
                .writeInteraction<Distribute>({
                    function: 'distribute',
                    timestamp: stamp.toString()
                })
            if (response?.originalTxId != undefined) {
                this.logger.log(`Completed distribution for ${stamp}`)
                return true
            } else {
                this.logger.error(`Failed distribution for ${stamp}`)
                return false
            }
        } else {
            this.logger.error(`Owner is undefined. Failed to complete distribution of ${stamp}`)
            return false
        }
    }
}
