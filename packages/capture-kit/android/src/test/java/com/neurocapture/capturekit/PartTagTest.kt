package com.neurocapture.capturekit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Decision 037: part uploads to S3 (200 + ETag) and to Azure Blob Storage (201, no ETag). */
class PartTagTest {
    @Test fun s3PartUsesItsEtag() = assertEquals("abc123", partTag(HttpResult(200, "\"abc123\"", ""), 1))

    @Test fun azurePutBlockHasNoEtag() = assertEquals("azure-7", partTag(HttpResult(201, null, ""), 7))

    @Test fun okWithoutEtagIsAFailedPart() = assertNull(partTag(HttpResult(200, null, ""), 1))

    @Test fun errorsAreFailedParts() {
        assertNull(partTag(HttpResult(403, null, "AuthorizationFailure"), 1))
        assertNull(partTag(HttpResult(500, "\"x\"", ""), 1))
    }
}
