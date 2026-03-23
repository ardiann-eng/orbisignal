/*
  Warnings:

  - You are about to drop the column `fearGreed` on the `Signal` table. All the data in the column will be lost.
  - You are about to drop the column `marketMood` on the `Signal` table. All the data in the column will be lost.
  - You are about to drop the column `sentiment` on the `Signal` table. All the data in the column will be lost.
  - Added the required column `oiChange` to the `Signal` table without a default value. This is not possible if the table is not empty.
  - Added the required column `oiValue` to the `Signal` table without a default value. This is not possible if the table is not empty.
  - Added the required column `openInterest` to the `Signal` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Signal" DROP COLUMN "fearGreed",
DROP COLUMN "marketMood",
DROP COLUMN "sentiment",
ADD COLUMN     "oiChange" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "oiValue" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "openInterest" INTEGER NOT NULL;
